use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use tauri::AppHandle;

pub(crate) const AI_DURABLE_FOUNDATION_SCHEMA_VERSION: i64 = 55;
pub(crate) const AI_ATTACHMENT_AUTHORIZATION_SCHEMA_VERSION: i64 = 56;
pub(crate) const AI_CONTEXT_REQUEST_SCHEMA_VERSION: i64 = 57;
pub(crate) const AI_STANDARD_RESULT_SCHEMA_VERSION: i64 = 58;

#[cfg(test)]
const CURRENT_CONVERSATION_ID: &str = "ai-conversation-global-current-v1";
#[cfg(test)]
const CURRENT_CONVERSATION_KEY: &str = "global-ai-chat/current/v1";
const MAX_MESSAGE_CHARS: usize = 45_000;
const MAX_ERROR_CHARS: usize = 300;
const MAX_TRACE_JSON_BYTES: usize = 128 * 1024;
pub(crate) const MAX_AUTHORIZED_FILE_REFS_PER_CALL: usize = 10;
pub(crate) const MAX_READABLE_MATERIAL_FILES_PER_CALL: usize = 3;
pub(crate) const MAX_READABLE_MATERIAL_BYTES_PER_FILE: usize = 65_536;
pub(crate) const MAX_TOTAL_READABLE_MATERIAL_BYTES_PER_CALL: usize = 131_072;
pub(crate) const MAX_INJECTED_MATERIAL_CHARACTERS: usize = 32_000;
pub(crate) const AI_MATERIAL_SUPPORTED_EXTENSIONS: [&str; 2] = [".md", ".txt"];

const AI_DURABLE_FOUNDATION_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  stable_key TEXT NOT NULL UNIQUE CHECK (length(trim(stable_key)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE RESTRICT,
  UNIQUE (conversation_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_order
  ON ai_messages(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS ai_call_attempts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) > 0),
  conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('chat_response','action_draft_generation','parse_draft')),
  trigger_message_id TEXT,
  trigger_call_attempt_id TEXT,
  result_message_id TEXT,
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
  context_package_id TEXT NOT NULL CHECK (length(trim(context_package_id)) > 0),
  context_package_version TEXT NOT NULL CHECK (length(trim(context_package_version)) > 0),
  context_source_refs_json TEXT NOT NULL CHECK (json_valid(context_source_refs_json)),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
  budget_summary_json TEXT CHECK (budget_summary_json IS NULL OR json_valid(budget_summary_json)),
  prompt_package_id TEXT NOT NULL CHECK (length(trim(prompt_package_id)) > 0),
  prompt_created_at TEXT NOT NULL CHECK (length(trim(prompt_created_at)) > 0),
  response_truncated INTEGER CHECK (response_truncated IS NULL OR response_truncated IN (0,1)),
  usage_input_tokens INTEGER CHECK (usage_input_tokens IS NULL OR usage_input_tokens >= 0),
  usage_output_tokens INTEGER CHECK (usage_output_tokens IS NULL OR usage_output_tokens >= 0),
  usage_total_tokens INTEGER CHECK (usage_total_tokens IS NULL OR usage_total_tokens >= 0),
  error_code TEXT,
  error_message TEXT,
  error_retryable INTEGER CHECK (error_retryable IS NULL OR error_retryable IN (0,1)),
  provider_status INTEGER CHECK (provider_status IS NULL OR provider_status >= 100),
  started_at TEXT NOT NULL CHECK (length(trim(started_at)) > 0),
  settled_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE RESTRICT,
  FOREIGN KEY (trigger_message_id) REFERENCES ai_messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (trigger_call_attempt_id) REFERENCES ai_call_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY (result_message_id) REFERENCES ai_messages(id) ON DELETE RESTRICT,
  UNIQUE (conversation_id, sequence),
  CHECK (trigger_message_id IS NOT NULL OR trigger_call_attempt_id IS NOT NULL),
  CHECK (purpose != 'chat_response' OR trigger_message_id IS NOT NULL),
  CHECK (purpose != 'action_draft_generation' OR
         (trigger_message_id IS NOT NULL AND trigger_call_attempt_id IS NOT NULL)),
  CHECK (purpose != 'parse_draft' OR trigger_message_id IS NOT NULL),
  CHECK (purpose != 'action_draft_generation' OR result_message_id IS NULL),
  CHECK (status != 'started' OR
         (settled_at IS NULL AND result_message_id IS NULL AND error_code IS NULL AND
          error_message IS NULL AND error_retryable IS NULL AND provider_status IS NULL)),
  CHECK (status != 'succeeded' OR
         (settled_at IS NOT NULL AND error_code IS NULL AND error_message IS NULL AND
          error_retryable IS NULL AND provider_status IS NULL)),
  CHECK (status != 'succeeded' OR purpose != 'chat_response' OR result_message_id IS NOT NULL),
  CHECK (status != 'failed' OR
         (settled_at IS NOT NULL AND result_message_id IS NULL AND error_code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_ai_call_attempts_conversation_order
  ON ai_call_attempts(conversation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_ai_call_attempts_trigger_message
  ON ai_call_attempts(trigger_message_id);
CREATE INDEX IF NOT EXISTS idx_ai_call_attempts_trigger_attempt
  ON ai_call_attempts(trigger_call_attempt_id);

CREATE TRIGGER IF NOT EXISTS trg_ai_call_attempt_terminal_immutable
BEFORE UPDATE ON ai_call_attempts
WHEN OLD.status IN ('succeeded','failed') AND (
  NEW.id IS NOT OLD.id OR
  NEW.request_id IS NOT OLD.request_id OR
  NEW.conversation_id IS NOT OLD.conversation_id OR
  NEW.sequence IS NOT OLD.sequence OR
  NEW.purpose IS NOT OLD.purpose OR
  NEW.trigger_message_id IS NOT OLD.trigger_message_id OR
  NEW.trigger_call_attempt_id IS NOT OLD.trigger_call_attempt_id OR
  NEW.result_message_id IS NOT OLD.result_message_id OR
  NEW.provider IS NOT OLD.provider OR
  NEW.model IS NOT OLD.model OR
  NEW.status IS NOT OLD.status OR
  NEW.context_package_id IS NOT OLD.context_package_id OR
  NEW.context_package_version IS NOT OLD.context_package_version OR
  NEW.context_source_refs_json IS NOT OLD.context_source_refs_json OR
  NEW.warnings_json IS NOT OLD.warnings_json OR
  NEW.budget_summary_json IS NOT OLD.budget_summary_json OR
  NEW.prompt_package_id IS NOT OLD.prompt_package_id OR
  NEW.prompt_created_at IS NOT OLD.prompt_created_at OR
  NEW.response_truncated IS NOT OLD.response_truncated OR
  NEW.usage_input_tokens IS NOT OLD.usage_input_tokens OR
  NEW.usage_output_tokens IS NOT OLD.usage_output_tokens OR
  NEW.usage_total_tokens IS NOT OLD.usage_total_tokens OR
  NEW.error_code IS NOT OLD.error_code OR
  NEW.error_message IS NOT OLD.error_message OR
  NEW.error_retryable IS NOT OLD.error_retryable OR
  NEW.provider_status IS NOT OLD.provider_status OR
  NEW.started_at IS NOT OLD.started_at OR
  NEW.settled_at IS NOT OLD.settled_at
)
BEGIN
  SELECT RAISE(ABORT, 'AI_DURABLE_TERMINAL_IMMUTABLE');
END;

INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (55, 'canonical_conversation_message_call_attempt_foundation');
"#;

const AI_ATTACHMENT_AUTHORIZATION_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS ai_call_attempt_file_ref_authorizations (
  call_attempt_id TEXT NOT NULL,
  file_ref_id TEXT NOT NULL CHECK (length(trim(file_ref_id)) > 0),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  resource_kind TEXT NOT NULL CHECK (resource_kind = 'file'),
  file_type TEXT NOT NULL CHECK (length(trim(file_type)) > 0),
  authorized_at TEXT NOT NULL CHECK (length(trim(authorized_at)) > 0),
  PRIMARY KEY (call_attempt_id, file_ref_id),
  FOREIGN KEY (call_attempt_id) REFERENCES ai_call_attempts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_call_attempt_file_ref_authorizations_file_ref
  ON ai_call_attempt_file_ref_authorizations(file_ref_id);

CREATE TRIGGER IF NOT EXISTS trg_ai_call_attempt_file_ref_authorization_immutable_update
BEFORE UPDATE ON ai_call_attempt_file_ref_authorizations
BEGIN
  SELECT RAISE(ABORT, 'AI_ATTACHMENT_AUTHORIZATION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_ai_call_attempt_file_ref_authorization_immutable_delete
BEFORE DELETE ON ai_call_attempt_file_ref_authorizations
WHEN EXISTS (
  SELECT 1 FROM ai_call_attempts WHERE id=OLD.call_attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'AI_ATTACHMENT_AUTHORIZATION_IMMUTABLE');
END;

INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (56, 'ai_call_attempt_file_ref_explicit_authorization');
"#;

const AI_CONTEXT_REQUEST_SCHEMA_SQL: &str = r#"
ALTER TABLE ai_messages ADD COLUMN message_kind TEXT NOT NULL DEFAULT 'text'
  CHECK (message_kind IN ('text','context_request_action'));
ALTER TABLE ai_messages ADD COLUMN action_type TEXT
  CHECK (action_type IS NULL OR action_type IN ('APPROVE_CONTEXT_REQUEST','REJECT_CONTEXT_REQUEST'));
ALTER TABLE ai_messages ADD COLUMN action_ref_id TEXT;

CREATE UNIQUE INDEX idx_ai_messages_context_request_action_identity
  ON ai_messages(action_ref_id)
  WHERE message_kind='context_request_action';

CREATE TRIGGER trg_ai_message_kind_insert_guard
BEFORE INSERT ON ai_messages
WHEN NOT (
  (NEW.message_kind='text' AND NEW.action_type IS NULL AND NEW.action_ref_id IS NULL) OR
  (NEW.message_kind='context_request_action' AND NEW.role='user' AND
   NEW.action_type IN ('APPROVE_CONTEXT_REQUEST','REJECT_CONTEXT_REQUEST') AND
   length(trim(NEW.action_ref_id)) > 0 AND NEW.content=NEW.action_type)
)
BEGIN
  SELECT RAISE(ABORT, 'AI_MESSAGE_KIND_INVALID');
END;

CREATE TRIGGER trg_ai_message_kind_update_guard
BEFORE UPDATE OF message_kind,action_type,action_ref_id,role,content ON ai_messages
WHEN NOT (
  (NEW.message_kind='text' AND NEW.action_type IS NULL AND NEW.action_ref_id IS NULL) OR
  (NEW.message_kind='context_request_action' AND NEW.role='user' AND
   NEW.action_type IN ('APPROVE_CONTEXT_REQUEST','REJECT_CONTEXT_REQUEST') AND
   length(trim(NEW.action_ref_id)) > 0 AND NEW.content=NEW.action_type)
)
BEGIN
  SELECT RAISE(ABORT, 'AI_MESSAGE_KIND_INVALID');
END;

CREATE TABLE ai_context_requests (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  conversation_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL UNIQUE,
  source_call_attempt_id TEXT NOT NULL UNIQUE,
  source_snapshot_json TEXT NOT NULL CHECK (json_valid(source_snapshot_json)),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  requested_refs_json TEXT NOT NULL CHECK (json_valid(requested_refs_json)),
  reviewed_candidates_json TEXT NOT NULL CHECK (json_valid(reviewed_candidates_json)),
  state TEXT NOT NULL CHECK (state IN ('PENDING','APPROVED','REJECTED','STALE_OR_INVALID')),
  decision_action_message_id TEXT UNIQUE,
  decision_type TEXT CHECK (decision_type IS NULL OR decision_type IN ('APPROVE','REJECT','STALE')),
  decision_at TEXT,
  decision_reason TEXT,
  approved_refs_json TEXT CHECK (approved_refs_json IS NULL OR json_valid(approved_refs_json)),
  followup_call_attempt_id TEXT UNIQUE,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id) REFERENCES ai_messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_call_attempt_id) REFERENCES ai_call_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY (decision_action_message_id) REFERENCES ai_messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (followup_call_attempt_id) REFERENCES ai_call_attempts(id) ON DELETE RESTRICT,
  CHECK (
    (state='PENDING' AND decision_action_message_id IS NULL AND decision_type IS NULL AND
     decision_at IS NULL AND decision_reason IS NULL AND approved_refs_json IS NULL AND
     followup_call_attempt_id IS NULL) OR
    (state='APPROVED' AND decision_action_message_id IS NOT NULL AND decision_type='APPROVE' AND
     decision_at IS NOT NULL AND approved_refs_json IS NOT NULL AND followup_call_attempt_id IS NOT NULL) OR
    (state='REJECTED' AND decision_action_message_id IS NOT NULL AND decision_type='REJECT' AND
     decision_at IS NOT NULL AND approved_refs_json IS NULL AND followup_call_attempt_id IS NULL) OR
    (state='STALE_OR_INVALID' AND decision_type='STALE' AND decision_at IS NOT NULL AND
     length(trim(decision_reason)) > 0 AND approved_refs_json IS NULL AND followup_call_attempt_id IS NULL)
  )
);

CREATE INDEX idx_ai_context_requests_conversation
  ON ai_context_requests(conversation_id, created_at, id);

CREATE TRIGGER trg_ai_context_request_terminal_immutable
BEFORE UPDATE ON ai_context_requests
WHEN OLD.state IN ('APPROVED','REJECTED','STALE_OR_INVALID')
BEGIN
  SELECT RAISE(ABORT, 'AI_CONTEXT_REQUEST_TERMINAL_IMMUTABLE');
END;

CREATE TRIGGER trg_ai_context_request_delete_guard
BEFORE DELETE ON ai_context_requests
BEGIN
  SELECT RAISE(ABORT, 'AI_CONTEXT_REQUEST_DELETE_FORBIDDEN');
END;

INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (57, 'same_conversation_ai_context_request_approval_loop');
"#;

const AI_CALL_ATTEMPT_V58_REBUILD_SQL: &str = r#"
DROP TRIGGER IF EXISTS trg_ai_call_attempt_terminal_immutable;
DROP INDEX IF EXISTS idx_ai_call_attempts_conversation_order;
DROP INDEX IF EXISTS idx_ai_call_attempts_trigger_message;
DROP INDEX IF EXISTS idx_ai_call_attempts_trigger_attempt;
PRAGMA legacy_alter_table=ON;
ALTER TABLE ai_call_attempts RENAME TO ai_call_attempts_v57;

CREATE TABLE ai_call_attempts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) > 0),
  conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('chat_response','action_draft_generation','parse_draft')),
  trigger_message_id TEXT,
  trigger_call_attempt_id TEXT,
  result_message_id TEXT,
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
  context_package_id TEXT NOT NULL CHECK (length(trim(context_package_id)) > 0),
  context_package_version TEXT NOT NULL CHECK (length(trim(context_package_version)) > 0),
  context_source_refs_json TEXT NOT NULL CHECK (json_valid(context_source_refs_json)),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
  budget_summary_json TEXT CHECK (budget_summary_json IS NULL OR json_valid(budget_summary_json)),
  prompt_package_id TEXT NOT NULL CHECK (length(trim(prompt_package_id)) > 0),
  prompt_created_at TEXT NOT NULL CHECK (length(trim(prompt_created_at)) > 0),
  response_truncated INTEGER CHECK (response_truncated IS NULL OR response_truncated IN (0,1)),
  usage_input_tokens INTEGER CHECK (usage_input_tokens IS NULL OR usage_input_tokens >= 0),
  usage_output_tokens INTEGER CHECK (usage_output_tokens IS NULL OR usage_output_tokens >= 0),
  usage_total_tokens INTEGER CHECK (usage_total_tokens IS NULL OR usage_total_tokens >= 0),
  error_code TEXT,
  error_message TEXT,
  error_retryable INTEGER CHECK (error_retryable IS NULL OR error_retryable IN (0,1)),
  provider_status INTEGER CHECK (provider_status IS NULL OR provider_status >= 100),
  started_at TEXT NOT NULL CHECK (length(trim(started_at)) > 0),
  settled_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE RESTRICT,
  FOREIGN KEY (trigger_message_id) REFERENCES ai_messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (trigger_call_attempt_id) REFERENCES ai_call_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY (result_message_id) REFERENCES ai_messages(id) ON DELETE RESTRICT,
  UNIQUE (conversation_id, sequence),
  CHECK (trigger_message_id IS NOT NULL OR trigger_call_attempt_id IS NOT NULL),
  CHECK (purpose != 'chat_response' OR trigger_message_id IS NOT NULL),
  CHECK (purpose != 'action_draft_generation' OR
         (trigger_message_id IS NOT NULL AND trigger_call_attempt_id IS NOT NULL)),
  CHECK (purpose != 'parse_draft' OR trigger_message_id IS NOT NULL),
  CHECK (purpose != 'action_draft_generation' OR result_message_id IS NULL),
  CHECK (status != 'started' OR
         (settled_at IS NULL AND result_message_id IS NULL AND error_code IS NULL AND
          error_message IS NULL AND error_retryable IS NULL AND provider_status IS NULL)),
  CHECK (status != 'succeeded' OR
         (settled_at IS NOT NULL AND error_code IS NULL AND error_message IS NULL AND
          error_retryable IS NULL AND provider_status IS NULL)),
  CHECK (status != 'succeeded' OR purpose != 'chat_response' OR result_message_id IS NOT NULL),
  CHECK (status != 'failed' OR
         (settled_at IS NOT NULL AND result_message_id IS NULL AND error_code IS NOT NULL))
);

INSERT INTO ai_call_attempts(
  id,request_id,conversation_id,sequence,purpose,trigger_message_id,
  trigger_call_attempt_id,result_message_id,provider,model,status,
  context_package_id,context_package_version,context_source_refs_json,warnings_json,
  budget_summary_json,prompt_package_id,prompt_created_at,response_truncated,
  usage_input_tokens,usage_output_tokens,usage_total_tokens,error_code,error_message,
  error_retryable,provider_status,started_at,settled_at
)
SELECT
  id,request_id,conversation_id,sequence,purpose,trigger_message_id,
  trigger_call_attempt_id,result_message_id,provider,model,status,
  context_package_id,context_package_version,context_source_refs_json,warnings_json,
  budget_summary_json,prompt_package_id,prompt_created_at,response_truncated,
  usage_input_tokens,usage_output_tokens,usage_total_tokens,error_code,error_message,
  error_retryable,provider_status,started_at,settled_at
FROM ai_call_attempts_v57;

DROP TABLE ai_call_attempts_v57;
PRAGMA legacy_alter_table=OFF;

CREATE INDEX idx_ai_call_attempts_conversation_order
  ON ai_call_attempts(conversation_id, sequence);
CREATE INDEX idx_ai_call_attempts_trigger_message
  ON ai_call_attempts(trigger_message_id);
CREATE INDEX idx_ai_call_attempts_trigger_attempt
  ON ai_call_attempts(trigger_call_attempt_id);

CREATE TRIGGER trg_ai_call_attempt_terminal_immutable
BEFORE UPDATE ON ai_call_attempts
WHEN OLD.status IN ('succeeded','failed') AND (
  NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id OR
  NEW.conversation_id IS NOT OLD.conversation_id OR NEW.sequence IS NOT OLD.sequence OR
  NEW.purpose IS NOT OLD.purpose OR NEW.trigger_message_id IS NOT OLD.trigger_message_id OR
  NEW.trigger_call_attempt_id IS NOT OLD.trigger_call_attempt_id OR
  NEW.result_message_id IS NOT OLD.result_message_id OR NEW.provider IS NOT OLD.provider OR
  NEW.model IS NOT OLD.model OR NEW.status IS NOT OLD.status OR
  NEW.context_package_id IS NOT OLD.context_package_id OR
  NEW.context_package_version IS NOT OLD.context_package_version OR
  NEW.context_source_refs_json IS NOT OLD.context_source_refs_json OR
  NEW.warnings_json IS NOT OLD.warnings_json OR
  NEW.budget_summary_json IS NOT OLD.budget_summary_json OR
  NEW.prompt_package_id IS NOT OLD.prompt_package_id OR
  NEW.prompt_created_at IS NOT OLD.prompt_created_at OR
  NEW.response_truncated IS NOT OLD.response_truncated OR
  NEW.usage_input_tokens IS NOT OLD.usage_input_tokens OR
  NEW.usage_output_tokens IS NOT OLD.usage_output_tokens OR
  NEW.usage_total_tokens IS NOT OLD.usage_total_tokens OR
  NEW.error_code IS NOT OLD.error_code OR NEW.error_message IS NOT OLD.error_message OR
  NEW.error_retryable IS NOT OLD.error_retryable OR
  NEW.provider_status IS NOT OLD.provider_status OR
  NEW.started_at IS NOT OLD.started_at OR NEW.settled_at IS NOT OLD.settled_at
)
BEGIN
  SELECT RAISE(ABORT, 'AI_DURABLE_TERMINAL_IMMUTABLE');
END;
"#;

const AI_STANDARD_RESULT_SCHEMA_SQL: &str = r#"
CREATE TABLE ai_standard_results (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  batch_id TEXT NOT NULL CHECK (length(trim(batch_id)) > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  conversation_id TEXT NOT NULL,
  parse_call_attempt_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('DATA_OPERATION','MANUSCRIPT_RESULT')),
  action TEXT NOT NULL CHECK (action IN ('CREATE','UPDATE','DELETE_SUGGESTION','NEW_MANUSCRIPT')),
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  original_payload_json TEXT NOT NULL CHECK (json_valid(original_payload_json)),
  visible_payload_json TEXT NOT NULL CHECK (json_valid(visible_payload_json)),
  visible_payload_fingerprint TEXT NOT NULL CHECK (length(trim(visible_payload_fingerprint)) > 0),
  target_snapshot_fingerprint TEXT,
  validation_issues_json TEXT NOT NULL CHECK (json_valid(validation_issues_json)),
  disposition TEXT NOT NULL CHECK (disposition IN ('PENDING','CONFIRMED','DISMISSED','STALE','FAILED')),
  confirmation_started_at TEXT,
  authorization_id TEXT UNIQUE,
  confirmed_payload_json TEXT CHECK (confirmed_payload_json IS NULL OR json_valid(confirmed_payload_json)),
  confirmed_payload_fingerprint TEXT,
  decided_at TEXT,
  effect_receipt_json TEXT CHECK (effect_receipt_json IS NULL OR json_valid(effect_receipt_json)),
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE RESTRICT,
  FOREIGN KEY (parse_call_attempt_id) REFERENCES ai_call_attempts(id) ON DELETE RESTRICT,
  UNIQUE (batch_id, ordinal),
  CHECK (
    (category='DATA_OPERATION' AND action IN ('CREATE','UPDATE','DELETE_SUGGESTION')) OR
    (category='MANUSCRIPT_RESULT' AND action='NEW_MANUSCRIPT')
  ),
  CHECK (
    (disposition='PENDING' AND decided_at IS NULL AND effect_receipt_json IS NULL AND
      failure_code IS NULL AND failure_message IS NULL AND
      ((confirmation_started_at IS NULL AND authorization_id IS NULL AND confirmed_payload_json IS NULL AND
        confirmed_payload_fingerprint IS NULL) OR
       (confirmation_started_at IS NOT NULL AND authorization_id IS NOT NULL AND confirmed_payload_json IS NOT NULL AND
        confirmed_payload_fingerprint IS NOT NULL))) OR
    (disposition='DISMISSED' AND confirmation_started_at IS NULL AND authorization_id IS NULL AND
      confirmed_payload_json IS NULL AND confirmed_payload_fingerprint IS NULL AND decided_at IS NOT NULL AND
      effect_receipt_json IS NULL AND failure_code IS NULL AND failure_message IS NULL) OR
    (disposition='CONFIRMED' AND confirmation_started_at IS NOT NULL AND authorization_id IS NOT NULL AND
      confirmed_payload_json IS NOT NULL AND confirmed_payload_fingerprint IS NOT NULL AND decided_at IS NOT NULL AND
      effect_receipt_json IS NOT NULL AND failure_code IS NULL AND failure_message IS NULL) OR
    (disposition IN ('STALE','FAILED') AND decided_at IS NOT NULL AND effect_receipt_json IS NULL AND
      failure_code IS NOT NULL AND failure_message IS NOT NULL)
  )
);

CREATE INDEX idx_ai_standard_results_conversation
  ON ai_standard_results(conversation_id, created_at, batch_id, ordinal);
CREATE INDEX idx_ai_standard_results_parse_attempt
  ON ai_standard_results(parse_call_attempt_id, ordinal);

CREATE TRIGGER trg_ai_standard_result_origin_immutable
BEFORE UPDATE ON ai_standard_results
WHEN NEW.id IS NOT OLD.id OR NEW.batch_id IS NOT OLD.batch_id OR NEW.ordinal IS NOT OLD.ordinal OR
  NEW.conversation_id IS NOT OLD.conversation_id OR
  NEW.parse_call_attempt_id IS NOT OLD.parse_call_attempt_id OR
  NEW.category IS NOT OLD.category OR NEW.action IS NOT OLD.action OR
  NEW.target_json IS NOT OLD.target_json OR NEW.source_json IS NOT OLD.source_json OR
  NEW.original_payload_json IS NOT OLD.original_payload_json OR
  NEW.target_snapshot_fingerprint IS NOT OLD.target_snapshot_fingerprint OR
  NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'AI_STANDARD_RESULT_ORIGIN_IMMUTABLE');
END;

CREATE TRIGGER trg_ai_standard_result_terminal_immutable
BEFORE UPDATE ON ai_standard_results
WHEN OLD.disposition IN ('CONFIRMED','DISMISSED','STALE','FAILED')
BEGIN
  SELECT RAISE(ABORT, 'AI_STANDARD_RESULT_TERMINAL_IMMUTABLE');
END;

CREATE TRIGGER trg_ai_standard_result_delete_forbidden
BEFORE DELETE ON ai_standard_results
BEGIN
  SELECT RAISE(ABORT, 'AI_STANDARD_RESULT_DELETE_FORBIDDEN');
END;

INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (58, 'parse_draft_minimal_standard_result_task_action_closure');
"#;

pub(crate) fn apply_schema_migration(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(AI_DURABLE_FOUNDATION_SCHEMA_SQL)
}

pub(crate) fn apply_attachment_authorization_schema_migration(
    connection: &Connection,
) -> rusqlite::Result<()> {
    connection.execute_batch(AI_ATTACHMENT_AUTHORIZATION_SCHEMA_SQL)
}

pub(crate) fn apply_context_request_schema_migration(
    connection: &Connection,
) -> rusqlite::Result<()> {
    connection.execute_batch(AI_CONTEXT_REQUEST_SCHEMA_SQL)
}

pub(crate) fn apply_standard_result_schema_migration(
    connection: &Connection,
) -> rusqlite::Result<()> {
    let call_attempt_sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_call_attempts'",
        [],
        |row| row.get(0),
    )?;
    if !call_attempt_sql.contains("'parse_draft'") {
        connection.execute_batch(AI_CALL_ATTEMPT_V58_REBUILD_SQL)?;
    }
    connection.execute_batch(AI_STANDARD_RESULT_SCHEMA_SQL)
}

pub(crate) fn standard_result_schema_is_current(
    connection: &Connection,
) -> rusqlite::Result<bool> {
    let table: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ai_standard_results'",
        [],
        |row| row.get(0),
    )?;
    let columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('ai_standard_results')",
        [],
        |row| row.get(0),
    )?;
    let indexes: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN (
           'idx_ai_standard_results_conversation','idx_ai_standard_results_parse_attempt'
         )",
        [],
        |row| row.get(0),
    )?;
    let triggers: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN (
           'trg_ai_standard_result_origin_immutable','trg_ai_standard_result_terminal_immutable',
           'trg_ai_standard_result_delete_forbidden'
         )",
        [],
        |row| row.get(0),
    )?;
    let marker: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations
         WHERE version=58 AND name='parse_draft_minimal_standard_result_task_action_closure'",
        [],
        |row| row.get(0),
    )?;
    let call_attempt_sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_call_attempts'",
        [],
        |row| row.get(0),
    )?;
    Ok(table == 1
        && columns == 25
        && indexes == 2
        && triggers == 3
        && marker == 1
        && call_attempt_sql.contains("'parse_draft'"))
}

pub(crate) fn context_request_schema_is_current(
    connection: &Connection,
) -> rusqlite::Result<bool> {
    let table: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ai_context_requests'",
        [],
        |row| row.get(0),
    )?;
    let message_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('ai_messages')
         WHERE name IN ('message_kind','action_type','action_ref_id')",
        [],
        |row| row.get(0),
    )?;
    let request_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('ai_context_requests')",
        [],
        |row| row.get(0),
    )?;
    let marker: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations
         WHERE version=57 AND name='same_conversation_ai_context_request_approval_loop'",
        [],
        |row| row.get(0),
    )?;
    let indexes: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN (
           'idx_ai_messages_context_request_action_identity',
           'idx_ai_context_requests_conversation'
         )",
        [],
        |row| row.get(0),
    )?;
    let triggers: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN (
           'trg_ai_message_kind_insert_guard','trg_ai_message_kind_update_guard',
           'trg_ai_context_request_terminal_immutable','trg_ai_context_request_delete_guard'
         )",
        [],
        |row| row.get(0),
    )?;
    Ok(table == 1
        && message_columns == 3
        && request_columns == 16
        && marker == 1
        && indexes == 2
        && triggers == 4)
}

pub(crate) fn schema_is_current(connection: &Connection) -> rusqlite::Result<bool> {
    let tables: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type='table' AND name IN ('ai_conversations','ai_messages','ai_call_attempts')",
        [],
        |row| row.get(0),
    )?;
    let conversation_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('ai_conversations')
         WHERE name IN ('id','stable_key','created_at','updated_at')",
        [],
        |row| row.get(0),
    )?;
    let message_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('ai_messages')
         WHERE name IN ('id','conversation_id','sequence','role','content','created_at')",
        [],
        |row| row.get(0),
    )?;
    let attempt_columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('ai_call_attempts')",
        [],
        |row| row.get(0),
    )?;
    let marker: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations
         WHERE version=55 AND name='canonical_conversation_message_call_attempt_foundation'",
        [],
        |row| row.get(0),
    )?;
    let indexes: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN (
          'idx_ai_messages_conversation_order',
          'idx_ai_call_attempts_conversation_order',
          'idx_ai_call_attempts_trigger_message',
          'idx_ai_call_attempts_trigger_attempt'
        )",
        [],
        |row| row.get(0),
    )?;
    let terminal_trigger: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type='trigger' AND name='trg_ai_call_attempt_terminal_immutable'",
        [],
        |row| row.get(0),
    )?;
    let attempt_sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_call_attempts'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let attempt_sql = attempt_sql.unwrap_or_default();

    Ok(tables == 3
        && conversation_columns == 4
        && message_columns == 6
        && attempt_columns == 28
        && marker == 1
        && indexes == 4
        && terminal_trigger == 1
        && attempt_sql.contains("status IN ('started','succeeded','failed')")
        && (attempt_sql.contains("purpose IN ('chat_response','action_draft_generation')")
            || attempt_sql.contains(
                "purpose IN ('chat_response','action_draft_generation','parse_draft')",
            ))
        && attempt_sql.contains("UNIQUE (conversation_id, sequence)"))
}

pub(crate) fn attachment_authorization_schema_is_current(
    connection: &Connection,
) -> rusqlite::Result<bool> {
    let table: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type='table' AND name='ai_call_attempt_file_ref_authorizations'",
        [],
        |row| row.get(0),
    )?;
    let columns: i64 = connection.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('ai_call_attempt_file_ref_authorizations')",
        [],
        |row| row.get(0),
    )?;
    let marker: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_migrations
         WHERE version=56 AND name='ai_call_attempt_file_ref_explicit_authorization'",
        [],
        |row| row.get(0),
    )?;
    let index: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type='index' AND name='idx_ai_call_attempt_file_ref_authorizations_file_ref'",
        [],
        |row| row.get(0),
    )?;
    let triggers: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN (
           'trg_ai_call_attempt_file_ref_authorization_immutable_update',
           'trg_ai_call_attempt_file_ref_authorization_immutable_delete'
         )",
        [],
        |row| row.get(0),
    )?;
    Ok(table == 1 && columns == 6 && marker == 1 && index == 1 && triggers == 2)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AIConversationRecord {
    pub id: String,
    pub stable_key: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AIConversationSummaryRecord {
    pub id: String,
    pub stable_key: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_user_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_message: Option<String>,
    pub message_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AIMessageRecord {
    pub id: String,
    pub conversation_id: String,
    pub sequence: i64,
    pub role: String,
    pub content: String,
    pub message_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_ref_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AIContextRequestRecord {
    pub id: String,
    pub conversation_id: String,
    pub source_message_id: String,
    pub source_call_attempt_id: String,
    pub source: Value,
    pub reason: String,
    pub requested_refs: Value,
    pub reviewed_candidates: Value,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_action_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved_refs: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub followup_call_attempt_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AIStandardResultRecord {
    pub id: String,
    pub batch_id: String,
    pub ordinal: i64,
    pub conversation_id: String,
    pub parse_call_attempt_id: String,
    pub category: String,
    pub action: String,
    pub target: Value,
    pub source: Value,
    pub original_payload: Value,
    pub visible_payload: Value,
    pub visible_payload_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_snapshot_fingerprint: Option<String>,
    pub validation_issues: Value,
    pub disposition: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmation_started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed_payload_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_receipt: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AIAuthorizedFileRefSnapshot {
    pub file_ref_id: String,
    pub display_name: String,
    pub resource_kind: String,
    pub file_type: String,
    pub availability_status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AISelectableFileRef {
    pub file_ref_id: String,
    pub display_name: String,
    pub resource_kind: String,
    pub file_type: String,
    pub availability_status: String,
    pub material_read_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_prompt_reservation_characters: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_freshness_receipt: Option<crate::authorized_material::MaterialFreshnessReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AISelectableFileRefCatalog {
    pub file_refs: Vec<AISelectableFileRef>,
    pub effective_readable_selection_limit: usize,
    pub supported_extensions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AIAuthorizedMaterialFileRef {
    pub file_ref_id: String,
    pub path: String,
    pub location_mode: String,
    pub resource_kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AIAuthorizedMaterialSelection {
    pub configured_root: Option<String>,
    pub purpose: String,
    pub trigger_message_content: String,
    pub context_request_followup: bool,
    pub context_source_refs: Value,
    pub files: Vec<AIAuthorizedMaterialFileRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AIAuthorizedMaterialGateError {
    NotAuthorized,
    AttemptNotActive,
    CurrentFileRefUnavailable,
    ReadFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AICallAttemptRecord {
    pub id: String,
    pub request_id: String,
    pub conversation_id: String,
    pub sequence: i64,
    pub purpose: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_call_attempt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_message_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub status: String,
    pub context_package_id: String,
    pub context_package_version: String,
    pub context_source_refs: Value,
    pub warnings: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_summary: Option<Value>,
    pub prompt_package_id: String,
    pub prompt_created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_input_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_output_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_total_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_retryable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_status: Option<i64>,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<String>,
    pub authorized_file_refs: Vec<AIAuthorizedFileRefSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AIConversationReadback {
    pub conversation: AIConversationRecord,
    pub messages: Vec<AIMessageRecord>,
    pub projected_messages: Vec<AIMessageRecord>,
    pub call_attempts: Vec<AICallAttemptRecord>,
    pub context_requests: Vec<AIContextRequestRecord>,
    pub standard_results: Vec<AIStandardResultRecord>,
    pub retry_regenerate: AIRetryRegenerateProjection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AIRetryRegenerateProjection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_assistant_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_source_attempt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_attempt_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_attempt_status: Option<String>,
    pub retry_eligible: bool,
    pub regenerate_eligible: bool,
    pub attachment_reauthorization_required: bool,
    pub active_conflict: bool,
    pub safe_integrity_state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAICallAttempt {
    pub provider_invocation_authorized: bool,
    pub readback: AIConversationReadback,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAIMessageInput {
    pub id: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewAIContextRequestInput {
    pub id: String,
    pub source: Value,
    pub reason: String,
    pub requested_refs: Value,
    pub reviewed_candidates: Value,
    pub initial_state: String,
    pub invalid_reason: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewAIStandardResultInput {
    pub id: String,
    pub ordinal: i64,
    pub category: String,
    pub action: String,
    pub target: Value,
    pub source: Value,
    pub original_payload: Value,
    pub visible_payload: Value,
    pub visible_payload_fingerprint: String,
    pub target_snapshot_fingerprint: Option<String>,
    pub validation_issues: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewAIStandardResultBatchInput {
    pub id: String,
    pub results: Vec<NewAIStandardResultInput>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAIConversationInput {
    pub id: String,
    pub stable_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareAICallAttemptInput {
    pub conversation_id: String,
    pub attempt_id: String,
    pub request_id: String,
    pub purpose: String,
    pub user_message: Option<NewAIMessageInput>,
    pub trigger_message_id: Option<String>,
    pub trigger_call_attempt_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub context_package_id: String,
    pub context_package_version: String,
    pub context_source_refs: Value,
    pub warnings: Value,
    pub budget_summary: Option<Value>,
    pub prompt_package_id: String,
    pub prompt_created_at: String,
    pub started_at: String,
    #[serde(default)]
    pub authorized_file_ref_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AIChatAttemptActionIntent {
    Retry,
    Regenerate,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareAIRetryRegenerateAttemptInput {
    pub conversation_id: String,
    pub attempt_id: String,
    pub request_id: String,
    pub action_intent: AIChatAttemptActionIntent,
    pub trigger_message_id: String,
    pub expected_source_attempt_id: String,
    pub expected_effective_message_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub context_package_id: String,
    pub context_package_version: String,
    pub context_source_refs: Value,
    pub warnings: Value,
    pub budget_summary: Option<Value>,
    pub prompt_package_id: String,
    pub prompt_created_at: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIUsageInput {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleAICallAttemptSuccessInput {
    pub attempt_id: String,
    pub provider: String,
    pub model: String,
    pub response_truncated: Option<bool>,
    pub usage: Option<AIUsageInput>,
    pub assistant_message: Option<NewAIMessageInput>,
    pub context_request: Option<NewAIContextRequestInput>,
    pub standard_result_batch: Option<NewAIStandardResultBatchInput>,
    pub settled_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareAIContextRequestFollowupInput {
    pub conversation_id: String,
    pub context_request_id: String,
    pub action_message_id: String,
    pub attempt_id: String,
    pub request_id: String,
    pub purpose: String,
    pub provider: String,
    pub model: String,
    pub context_package_id: String,
    pub context_package_version: String,
    pub context_source_refs: Value,
    pub warnings: Value,
    pub budget_summary: Option<Value>,
    pub prompt_package_id: String,
    pub prompt_created_at: String,
    pub expected_reviewed_candidates: Value,
    pub approved_refs: Value,
    pub started_at: String,
    #[serde(default)]
    pub authorized_file_ref_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateAIStandardResultDraftInput {
    pub conversation_id: String,
    pub result_id: String,
    pub expected_visible_payload_fingerprint: String,
    pub visible_payload: Value,
    pub visible_payload_fingerprint: String,
    pub validation_issues: Value,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecideAIStandardResultInput {
    pub conversation_id: String,
    pub result_id: String,
    pub expected_visible_payload_fingerprint: String,
    pub decided_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginAIStandardResultConfirmationInput {
    pub conversation_id: String,
    pub result_id: String,
    pub parse_call_attempt_id: String,
    pub expected_visible_payload_fingerprint: String,
    pub authorization_id: String,
    pub confirmed_payload: Value,
    pub confirmed_payload_fingerprint: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettleAIStandardResultEffectInput {
    pub conversation_id: String,
    pub result_id: String,
    pub authorization_id: String,
    pub effect_receipt: Value,
    pub settled_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FailAIStandardResultInput {
    pub conversation_id: String,
    pub result_id: String,
    pub authorization_id: Option<String>,
    pub failure_code: String,
    pub failure_message: String,
    pub disposition: String,
    pub failed_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecideAIContextRequestInput {
    pub conversation_id: String,
    pub context_request_id: String,
    pub action_message_id: String,
    pub decided_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkAIContextRequestStaleInput {
    pub conversation_id: String,
    pub context_request_id: String,
    pub reason: String,
    pub decided_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleAICallAttemptFailureInput {
    pub attempt_id: String,
    pub error_code: String,
    pub error_message: Option<String>,
    pub error_retryable: bool,
    pub provider_status: Option<i64>,
    pub settled_at: String,
}

fn fail(code: &str, message: impl AsRef<str>) -> String {
    format!("code={code} message={}", message.as_ref())
}

fn require_text(value: &str, field: &str, max_chars: usize) -> Result<(), String> {
    let count = value.chars().count();
    if value.trim().is_empty() || count > max_chars {
        return Err(fail(
            "AI_DURABLE_INPUT_INVALID",
            format!("{field} must contain 1..={max_chars} characters"),
        ));
    }
    Ok(())
}

fn json_text(value: &Value, field: &str) -> Result<String, String> {
    let serialized = serde_json::to_string(value).map_err(|_| {
        fail(
            "AI_DURABLE_INPUT_INVALID",
            format!("{field} is not serializable"),
        )
    })?;
    if serialized.len() > MAX_TRACE_JSON_BYTES {
        return Err(fail(
            "AI_DURABLE_INPUT_INVALID",
            format!("{field} exceeds the safe trace limit"),
        ));
    }
    Ok(serialized)
}

fn optional_json_text(value: &Option<Value>, field: &str) -> Result<Option<String>, String> {
    value
        .as_ref()
        .map(|value| json_text(value, field))
        .transpose()
}

fn value_array<'a>(value: &'a Value, field: &str, min: usize, max: usize) -> Result<&'a Vec<Value>, String> {
    let values = value.as_array().ok_or_else(|| {
        fail(
            "AI_CONTEXT_REQUEST_INVALID",
            format!("{field} must be a JSON array"),
        )
    })?;
    if values.len() < min || values.len() > max {
        return Err(fail(
            "AI_CONTEXT_REQUEST_INVALID",
            format!("{field} must contain {min}..={max} entries without truncation"),
        ));
    }
    Ok(values)
}

fn validate_context_request_input(input: &NewAIContextRequestInput) -> Result<(), String> {
    require_text(&input.id, "contextRequest.id", 200)?;
    require_text(&input.reason, "contextRequest.reason", 600)?;
    require_text(&input.created_at, "contextRequest.createdAt", 80)?;
    let source = input.source.as_object().ok_or_else(|| {
        fail(
            "AI_CONTEXT_REQUEST_INVALID",
            "Context Request source snapshot must be an object",
        )
    })?;
    if !source
        .get("projectId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty() && value.chars().count() <= 200)
        || !source
            .get("contextMode")
            .and_then(Value::as_str)
            .is_some_and(|value| {
                matches!(
                    value,
                    "MINIMAL" | "BRIEF" | "STANDARD" | "DETAILED" |
                    "MINIMUM_BACKGROUND" | "PROJECT_BACKGROUND" | "LIGHT" |
                    "STANDARD_CONTEXT"
                )
            })
        || !source.get("contextBudget").is_some_and(Value::is_object)
        || !source
            .get("contextReviewFingerprint")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty() && value.chars().count() <= 200)
    {
        return Err(fail(
            "AI_CONTEXT_REQUEST_INVALID",
            "Context Request source snapshot is incomplete or incompatible",
        ));
    }
    value_array(
        source.get("researchObjects").unwrap_or(&Value::Null),
        "contextRequest.source.researchObjects",
        1,
        8,
    )?;
    value_array(
        source.get("requestableRefs").unwrap_or(&Value::Null),
        "contextRequest.source.requestableRefs",
        1,
        24,
    )?;
    let requested = value_array(
        &input.requested_refs,
        "contextRequest.requestedRefs",
        1,
        8,
    )?;
    let reviewed = value_array(
        &input.reviewed_candidates,
        "contextRequest.reviewedCandidates",
        1,
        8,
    )?;
    if requested.len() != reviewed.len() {
        return Err(fail(
            "AI_CONTEXT_REQUEST_INVALID",
            "Every requested ref must have exactly one canonical reviewed candidate",
        ));
    }
    json_text(&input.source, "contextRequest.source")?;
    json_text(&input.requested_refs, "contextRequest.requestedRefs")?;
    json_text(
        &input.reviewed_candidates,
        "contextRequest.reviewedCandidates",
    )?;
    let all_available = reviewed.iter().all(|candidate| {
        candidate
            .get("availability")
            .and_then(Value::as_str)
            == Some("available")
    });
    match input.initial_state.as_str() {
        "PENDING" if all_available && input.invalid_reason.is_none() => Ok(()),
        "STALE_OR_INVALID"
            if input
                .invalid_reason
                .as_deref()
                .is_some_and(|reason| !reason.trim().is_empty() && reason.chars().count() <= 600) =>
        {
            Ok(())
        }
        _ => Err(fail(
            "AI_CONTEXT_REQUEST_INVALID",
            "Context Request initial lifecycle state is inconsistent with its reviewed candidates",
        )),
    }
}

fn parse_json(value: String, field: &str) -> Result<Value, String> {
    serde_json::from_str(&value)
        .map_err(|_| fail("AI_DURABLE_READ_FAILED", format!("invalid {field} JSON")))
}

fn read_conversation_record(
    connection: &Connection,
    conversation_id: &str,
) -> Result<AIConversationRecord, String> {
    connection
        .query_row(
            "SELECT id,stable_key,created_at,updated_at FROM ai_conversations WHERE id=?1",
            [conversation_id],
            |row| {
                Ok(AIConversationRecord {
                    id: row.get(0)?,
                    stable_key: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            },
        )
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))
}

pub(crate) fn create_ai_conversation_in_connection(
    connection: &Connection,
    input: &CreateAIConversationInput,
) -> Result<AIConversationRecord, String> {
    require_text(&input.id, "conversation.id", 200)?;
    require_text(&input.stable_key, "conversation.stableKey", 240)?;
    require_text(&input.created_at, "conversation.createdAt", 80)?;
    connection
        .execute(
            "INSERT INTO ai_conversations(id,stable_key,created_at,updated_at)
             VALUES (?1,?2,?3,?3)
             ON CONFLICT(id) DO NOTHING",
            params![input.id, input.stable_key, input.created_at],
        )
        .map_err(|error| fail("AI_DURABLE_WRITE_FAILED", error.to_string()))?;
    let conversation = read_conversation_record(connection, &input.id)?;
    if conversation.stable_key != input.stable_key
        || conversation.created_at != input.created_at
    {
        return Err(fail(
            "AI_DURABLE_IDEMPOTENCY_CONFLICT",
            "Conversation identity was replayed with different canonical facts",
        ));
    }
    Ok(conversation)
}

fn read_messages(
    connection: &Connection,
    conversation_id: &str,
) -> Result<Vec<AIMessageRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,conversation_id,sequence,role,content,message_kind,action_type,action_ref_id,created_at
             FROM ai_messages WHERE conversation_id=?1 ORDER BY sequence ASC",
        )
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    let rows = statement
        .query_map([conversation_id], |row| {
            Ok(AIMessageRecord {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                sequence: row.get(2)?,
                role: row.get(3)?,
                content: row.get(4)?,
                message_kind: row.get(5)?,
                action_type: row.get(6)?,
                action_ref_id: row.get(7)?,
                created_at: row.get(8)?,
            })
        })
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))
}

fn read_context_requests(
    connection: &Connection,
    conversation_id: &str,
) -> Result<Vec<AIContextRequestRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,conversation_id,source_message_id,source_call_attempt_id,
                    source_snapshot_json,reason,requested_refs_json,reviewed_candidates_json,
                    state,decision_action_message_id,decision_type,decision_at,decision_reason,
                    approved_refs_json,followup_call_attempt_id,created_at
             FROM ai_context_requests WHERE conversation_id=?1 ORDER BY created_at ASC,id ASC",
        )
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    let rows = statement
        .query_map([conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, String>(15)?,
            ))
        })
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    rows.map(|row| {
        let (
            id,
            conversation_id,
            source_message_id,
            source_call_attempt_id,
            source_json,
            reason,
            requested_json,
            reviewed_json,
            state,
            decision_action_message_id,
            decision_type,
            decision_at,
            decision_reason,
            approved_json,
            followup_call_attempt_id,
            created_at,
        ) = row.map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
        Ok(AIContextRequestRecord {
            id,
            conversation_id,
            source_message_id,
            source_call_attempt_id,
            source: parse_json(source_json, "context_request_source")?,
            reason,
            requested_refs: parse_json(requested_json, "context_request_requested_refs")?,
            reviewed_candidates: parse_json(reviewed_json, "context_request_reviewed_candidates")?,
            state,
            decision_action_message_id,
            decision_type,
            decision_at,
            decision_reason,
            approved_refs: approved_json
                .map(|value| parse_json(value, "context_request_approved_refs"))
                .transpose()?,
            followup_call_attempt_id,
            created_at,
        })
    })
    .collect()
}

fn read_standard_results(
    connection: &Connection,
    conversation_id: &str,
) -> Result<Vec<AIStandardResultRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,batch_id,ordinal,conversation_id,parse_call_attempt_id,category,action,
                    target_json,source_json,original_payload_json,visible_payload_json,
                    visible_payload_fingerprint,target_snapshot_fingerprint,validation_issues_json,
                    disposition,confirmation_started_at,authorization_id,confirmed_payload_json,
                    confirmed_payload_fingerprint,decided_at,effect_receipt_json,failure_code,
                    failure_message,created_at,updated_at
             FROM ai_standard_results
             WHERE conversation_id=?1 ORDER BY created_at ASC,batch_id ASC,ordinal ASC",
        )
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    let rows = statement
        .query_map([conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, String>(13)?,
                row.get::<_, String>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, Option<String>>(16)?,
                row.get::<_, Option<String>>(17)?,
                row.get::<_, Option<String>>(18)?,
                row.get::<_, Option<String>>(19)?,
                row.get::<_, Option<String>>(20)?,
                row.get::<_, Option<String>>(21)?,
                row.get::<_, Option<String>>(22)?,
                row.get::<_, String>(23)?,
                row.get::<_, String>(24)?,
            ))
        })
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    rows.map(|row| {
        let row = row.map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
        Ok(AIStandardResultRecord {
            id: row.0,
            batch_id: row.1,
            ordinal: row.2,
            conversation_id: row.3,
            parse_call_attempt_id: row.4,
            category: row.5,
            action: row.6,
            target: parse_json(row.7, "standard_result_target")?,
            source: parse_json(row.8, "standard_result_source")?,
            original_payload: parse_json(row.9, "standard_result_original_payload")?,
            visible_payload: parse_json(row.10, "standard_result_visible_payload")?,
            visible_payload_fingerprint: row.11,
            target_snapshot_fingerprint: row.12,
            validation_issues: parse_json(row.13, "standard_result_validation_issues")?,
            disposition: row.14,
            confirmation_started_at: row.15,
            authorization_id: row.16,
            confirmed_payload: row
                .17
                .map(|value| parse_json(value, "standard_result_confirmed_payload"))
                .transpose()?,
            confirmed_payload_fingerprint: row.18,
            decided_at: row.19,
            effect_receipt: row
                .20
                .map(|value| parse_json(value, "standard_result_effect_receipt"))
                .transpose()?,
            failure_code: row.21,
            failure_message: row.22,
            created_at: row.23,
            updated_at: row.24,
        })
    })
    .collect()
}

fn row_to_call_attempt(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(AICallAttemptRecord, String, String, Option<String>)> {
    let source_refs_json: String = row.get(13)?;
    let warnings_json: String = row.get(14)?;
    let budget_json: Option<String> = row.get(15)?;
    let retryable: Option<i64> = row.get(24)?;
    Ok((
        AICallAttemptRecord {
            id: row.get(0)?,
            request_id: row.get(1)?,
            conversation_id: row.get(2)?,
            sequence: row.get(3)?,
            purpose: row.get(4)?,
            trigger_message_id: row.get(5)?,
            trigger_call_attempt_id: row.get(6)?,
            result_message_id: row.get(7)?,
            provider: row.get(8)?,
            model: row.get(9)?,
            status: row.get(10)?,
            context_package_id: row.get(11)?,
            context_package_version: row.get(12)?,
            context_source_refs: Value::Null,
            warnings: Value::Null,
            budget_summary: None,
            prompt_package_id: row.get(16)?,
            prompt_created_at: row.get(17)?,
            response_truncated: row.get::<_, Option<i64>>(18)?.map(|value| value != 0),
            usage_input_tokens: row.get(19)?,
            usage_output_tokens: row.get(20)?,
            usage_total_tokens: row.get(21)?,
            error_code: row.get(22)?,
            error_message: row.get(23)?,
            error_retryable: retryable.map(|value| value != 0),
            provider_status: row.get(25)?,
            started_at: row.get(26)?,
            settled_at: row.get(27)?,
            authorized_file_refs: Vec::new(),
        },
        source_refs_json,
        warnings_json,
        budget_json,
    ))
}

const CALL_ATTEMPT_SELECT: &str =
    "SELECT id,request_id,conversation_id,sequence,purpose,trigger_message_id,
            trigger_call_attempt_id,result_message_id,provider,model,status,
            context_package_id,context_package_version,context_source_refs_json,warnings_json,
            budget_summary_json,prompt_package_id,prompt_created_at,
            response_truncated,usage_input_tokens,usage_output_tokens,usage_total_tokens,
            error_code,error_message,error_retryable,provider_status,started_at,settled_at
     FROM ai_call_attempts";

fn decode_call_attempt(
    raw: (AICallAttemptRecord, String, String, Option<String>),
) -> Result<AICallAttemptRecord, String> {
    let (mut record, source_refs_json, warnings_json, budget_json) = raw;
    record.context_source_refs = parse_json(source_refs_json, "context_source_refs")?;
    record.warnings = parse_json(warnings_json, "warnings")?;
    record.budget_summary = budget_json
        .map(|value| parse_json(value, "budget_summary"))
        .transpose()?;
    Ok(record)
}

fn safe_display_fragment(value: &str, max_chars: usize) -> Option<String> {
    let cleaned = value
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let leaf = cleaned
        .split(['/', '\\'])
        .filter(|part| !part.trim().is_empty())
        .next_back()?
        .trim();
    if leaf.is_empty() {
        return None;
    }
    Some(leaf.chars().take(max_chars).collect())
}

fn safe_display_name(title: &str, path: &str) -> String {
    safe_display_fragment(title, 160)
        .or_else(|| safe_display_fragment(path, 160))
        .unwrap_or_else(|| "Attachment".to_string())
}

fn safe_file_type(value: &str) -> String {
    let safe = value
        .chars()
        .filter(|character| !character.is_control() && *character != '/' && *character != '\\')
        .take(80)
        .collect::<String>();
    let safe = safe.trim();
    if safe.is_empty() {
        "unknown".to_string()
    } else {
        safe.to_string()
    }
}

pub(crate) fn is_supported_ai_material_path(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "md" | "txt"))
}

fn file_availability(
    resource_kind: &str,
    path: &str,
    location_mode: &str,
    active: bool,
    configured_root: Option<&str>,
) -> &'static str {
    if !active || resource_kind != "file" {
        return "unavailable";
    }
    let root = if location_mode == "managed" {
        let Some(root) = configured_root else {
            return "unavailable";
        };
        Some(root)
    } else {
        None
    };
    if crate::native_open::canonical_path_is_available(path, resource_kind, root) {
        "available"
    } else {
        "unavailable"
    }
}

fn read_managed_root(connection: &Connection) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT configured_root FROM managed_root_settings
             WHERE id='managed-root' AND deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))
}

fn read_authorized_file_refs(
    connection: &Connection,
    attempt_id: &str,
) -> Result<Vec<AIAuthorizedFileRefSnapshot>, String> {
    let configured_root = read_managed_root(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT authorization.file_ref_id,authorization.display_name,
                    authorization.resource_kind,authorization.file_type,
                    current.resource_kind,current.path,current.location_mode,current.deleted_at
             FROM ai_call_attempt_file_ref_authorizations authorization
             LEFT JOIN file_refs current ON current.id=authorization.file_ref_id
             WHERE authorization.call_attempt_id=?1
             ORDER BY authorization.file_ref_id ASC",
        )
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    let rows = statement
        .query_map([attempt_id], |row| {
            let current_kind: Option<String> = row.get(4)?;
            let current_path: Option<String> = row.get(5)?;
            let current_location_mode: Option<String> = row.get(6)?;
            let deleted_at: Option<String> = row.get(7)?;
            let availability = match (
                current_kind.as_deref(),
                current_path.as_deref(),
                current_location_mode.as_deref(),
            ) {
                (Some(kind), Some(path), Some(location_mode)) => file_availability(
                    kind,
                    path,
                    location_mode,
                    deleted_at.is_none(),
                    configured_root.as_deref(),
                ),
                _ => "unavailable",
            };
            Ok(AIAuthorizedFileRefSnapshot {
                file_ref_id: row.get(0)?,
                display_name: row.get(1)?,
                resource_kind: row.get(2)?,
                file_type: row.get(3)?,
                availability_status: availability.to_string(),
            })
        })
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))
}

fn resolve_authorized_material_user_question(
    connection: &Connection,
    conversation_id: &str,
    attempt_id: &str,
    trigger_message_id: &str,
) -> Result<(String, bool), AIAuthorizedMaterialGateError> {
    let mut current_attempt_id = attempt_id.to_string();
    let mut current_trigger_message_id = trigger_message_id.to_string();
    let mut context_request_followup = false;
    for _ in 0..8 {
        let message: (String, String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT content,message_kind,action_type,action_ref_id FROM ai_messages
                 WHERE id=?1 AND conversation_id=?2 AND role='user'",
                params![current_trigger_message_id, conversation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|_| AIAuthorizedMaterialGateError::NotAuthorized)?;
        if message.1 == "text" && message.2.is_none() && message.3.is_none() {
            return Ok((message.0, context_request_followup));
        }
        if message.1 != "context_request_action"
            || message.2.as_deref() != Some("APPROVE_CONTEXT_REQUEST")
        {
            return Err(AIAuthorizedMaterialGateError::NotAuthorized);
        }
        let context_request_id = message
            .3
            .ok_or(AIAuthorizedMaterialGateError::NotAuthorized)?;
        context_request_followup = true;
        let source_attempt_id: String = connection
            .query_row(
                "SELECT source_call_attempt_id FROM ai_context_requests
                 WHERE id=?1 AND conversation_id=?2 AND state='APPROVED'
                   AND decision_action_message_id=?3 AND followup_call_attempt_id=?4",
                params![
                    context_request_id,
                    conversation_id,
                    current_trigger_message_id,
                    current_attempt_id,
                ],
                |row| row.get(0),
            )
            .map_err(|_| AIAuthorizedMaterialGateError::NotAuthorized)?;
        let source_trigger_message_id: String = connection
            .query_row(
                "SELECT trigger_message_id FROM ai_call_attempts
                 WHERE id=?1 AND conversation_id=?2 AND purpose IN ('chat_response','parse_draft')
                   AND status='succeeded'",
                params![source_attempt_id, conversation_id],
                |row| row.get(0),
            )
            .map_err(|_| AIAuthorizedMaterialGateError::NotAuthorized)?;
        current_attempt_id = source_attempt_id;
        current_trigger_message_id = source_trigger_message_id;
    }
    Err(AIAuthorizedMaterialGateError::NotAuthorized)
}

pub(crate) fn read_authorized_material_selection_in_connection(
    connection: &Connection,
    attempt_id: &str,
    conversation_id: &str,
    trigger_message_id: &str,
) -> Result<AIAuthorizedMaterialSelection, AIAuthorizedMaterialGateError> {
    let attempt = connection
        .query_row(
            "SELECT request_id,conversation_id,purpose,trigger_message_id,status,
                    context_source_refs_json
             FROM ai_call_attempts WHERE id=?1",
            [attempt_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|_| AIAuthorizedMaterialGateError::ReadFailed)?;
    let Some((
        request_id,
        stored_conversation_id,
        purpose,
        stored_trigger_message_id,
        status,
        context_source_refs_json,
    )) = attempt
    else {
        return Err(AIAuthorizedMaterialGateError::NotAuthorized);
    };
    if request_id != attempt_id
        || stored_conversation_id != conversation_id
        || !matches!(purpose.as_str(), "chat_response" | "parse_draft")
        || stored_trigger_message_id.as_deref() != Some(trigger_message_id)
    {
        return Err(AIAuthorizedMaterialGateError::NotAuthorized);
    }
    if status != "started" {
        return Err(AIAuthorizedMaterialGateError::AttemptNotActive);
    }
    let context_source_refs = serde_json::from_str::<Value>(&context_source_refs_json)
        .map_err(|_| AIAuthorizedMaterialGateError::ReadFailed)?;

    let (trigger_message_content, context_request_followup) = resolve_authorized_material_user_question(
        connection,
        conversation_id,
        attempt_id,
        trigger_message_id,
    )?;

    let mut statement = connection
        .prepare(
            "SELECT authorization.file_ref_id,current.path,current.location_mode,
                    current.resource_kind,current.deleted_at
             FROM ai_call_attempt_file_ref_authorizations authorization
             LEFT JOIN file_refs current ON current.id=authorization.file_ref_id
             WHERE authorization.call_attempt_id=?1
             ORDER BY authorization.file_ref_id ASC",
        )
        .map_err(|_| AIAuthorizedMaterialGateError::ReadFailed)?;
    let rows = statement
        .query_map([attempt_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|_| AIAuthorizedMaterialGateError::ReadFailed)?;
    let current_rows = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| AIAuthorizedMaterialGateError::ReadFailed)?;
    if current_rows.is_empty() {
        return Ok(AIAuthorizedMaterialSelection {
            configured_root: None,
            purpose,
            trigger_message_content,
            context_request_followup,
            context_source_refs,
            files: Vec::new(),
        });
    }
    let configured_root =
        read_managed_root(connection).map_err(|_| AIAuthorizedMaterialGateError::ReadFailed)?;
    let mut files = Vec::with_capacity(current_rows.len());
    for (file_ref_id, path, location_mode, resource_kind, deleted_at) in current_rows {
        let (Some(path), Some(location_mode), Some(resource_kind)) =
            (path, location_mode, resource_kind)
        else {
            return Err(AIAuthorizedMaterialGateError::CurrentFileRefUnavailable);
        };
        if deleted_at.is_some() || resource_kind != "file" {
            return Err(AIAuthorizedMaterialGateError::CurrentFileRefUnavailable);
        }
        files.push(AIAuthorizedMaterialFileRef {
            file_ref_id,
            path,
            location_mode,
            resource_kind,
        });
    }
    Ok(AIAuthorizedMaterialSelection {
        configured_root,
        purpose,
        trigger_message_content,
        context_request_followup,
        context_source_refs,
        files,
    })
}

fn hydrate_authorized_file_refs(
    connection: &Connection,
    mut record: AICallAttemptRecord,
) -> Result<AICallAttemptRecord, String> {
    record.authorized_file_refs = read_authorized_file_refs(connection, &record.id)?;
    Ok(record)
}

fn read_call_attempt_by_id(
    connection: &Connection,
    attempt_id: &str,
) -> Result<AICallAttemptRecord, String> {
    let sql = format!("{CALL_ATTEMPT_SELECT} WHERE id=?1");
    let raw = connection
        .query_row(&sql, [attempt_id], row_to_call_attempt)
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    hydrate_authorized_file_refs(connection, decode_call_attempt(raw)?)
}

fn read_call_attempt_by_id_without_authorizations(
    connection: &Connection,
    attempt_id: &str,
) -> Result<Option<AICallAttemptRecord>, String> {
    let sql = format!("{CALL_ATTEMPT_SELECT} WHERE id=?1");
    let raw = connection
        .query_row(&sql, [attempt_id], row_to_call_attempt)
        .optional()
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    raw.map(decode_call_attempt).transpose()
}

fn read_call_attempt_by_request_id(
    connection: &Connection,
    request_id: &str,
) -> Result<Option<AICallAttemptRecord>, String> {
    let sql = format!("{CALL_ATTEMPT_SELECT} WHERE request_id=?1");
    let raw = connection
        .query_row(&sql, [request_id], row_to_call_attempt)
        .optional()
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    raw.map(decode_call_attempt)
        .transpose()?
        .map(|record| hydrate_authorized_file_refs(connection, record))
        .transpose()
}

fn read_call_attempts(
    connection: &Connection,
    conversation_id: &str,
) -> Result<Vec<AICallAttemptRecord>, String> {
    read_call_attempts_without_authorizations(connection, conversation_id)?
        .into_iter()
        .map(|record| hydrate_authorized_file_refs(connection, record))
        .collect()
}

fn read_call_attempts_without_authorizations(
    connection: &Connection,
    conversation_id: &str,
) -> Result<Vec<AICallAttemptRecord>, String> {
    let sql = format!("{CALL_ATTEMPT_SELECT} WHERE conversation_id=?1 ORDER BY sequence ASC");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    let rows = statement
        .query_map([conversation_id], row_to_call_attempt)
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    let raw = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    raw.into_iter().map(decode_call_attempt).collect()
}

#[derive(Debug)]
struct AIConversationProjectionCore {
    projected_messages: Vec<AIMessageRecord>,
    latest_turn_id: Option<String>,
    effective_assistant_message_id: Option<String>,
    effective_source_attempt_id: Option<String>,
    latest_attempt_id: Option<String>,
    latest_attempt_status: Option<String>,
    malformed_success_ignored: bool,
}

fn project_effective_conversation(
    conversation_id: &str,
    messages: &[AIMessageRecord],
    attempts: &[AICallAttemptRecord],
) -> AIConversationProjectionCore {
    let message_by_id = messages
        .iter()
        .map(|message| (message.id.as_str(), message))
        .collect::<HashMap<_, _>>();
    let mut user_messages = messages
        .iter()
        .filter(|message| {
            message.conversation_id == conversation_id &&
                message.role == "user" &&
                (message.message_kind == "text" ||
                    (message.message_kind == "context_request_action" &&
                        message.action_type.as_deref() == Some("APPROVE_CONTEXT_REQUEST")))
        })
        .collect::<Vec<_>>();
    user_messages.sort_by_key(|message| message.sequence);

    let latest_turn_id = user_messages.last().map(|message| message.id.clone());
    let mut projected_messages = Vec::with_capacity(user_messages.len().saturating_mul(2));
    let mut latest_effective_message_id = None;
    let mut latest_effective_attempt_id = None;
    let mut latest_attempt_id = None;
    let mut latest_attempt_status = None;
    let mut malformed_success_ignored = false;

    for user_message in user_messages {
        if user_message.message_kind == "text" {
            projected_messages.push(user_message.clone());
        }
        let mut group = attempts
            .iter()
            .filter(|attempt| {
                attempt.conversation_id == conversation_id
                    && attempt.purpose == "chat_response"
                    && attempt.trigger_message_id.as_deref() == Some(user_message.id.as_str())
            })
            .collect::<Vec<_>>();
        group.sort_by_key(|attempt| attempt.sequence);

        let mut effective: Option<(&AICallAttemptRecord, &AIMessageRecord)> = None;
        for attempt in &group {
            if attempt.status != "succeeded" {
                continue;
            }
            let valid_result = attempt
                .result_message_id
                .as_deref()
                .and_then(|message_id| message_by_id.get(message_id).copied())
                .filter(|message| {
                    message.conversation_id == conversation_id
                        && message.role == "assistant"
                        && message.sequence > user_message.sequence
                });
            if let Some(result_message) = valid_result {
                if effective
                    .as_ref()
                    .is_none_or(|(current, _)| attempt.sequence > current.sequence)
                {
                    effective = Some((attempt, result_message));
                }
            } else {
                malformed_success_ignored = true;
            }
        }

        if let Some((attempt, message)) = effective {
            projected_messages.push(message.clone());
            if latest_turn_id.as_deref() == Some(user_message.id.as_str()) {
                latest_effective_message_id = Some(message.id.clone());
                latest_effective_attempt_id = Some(attempt.id.clone());
            }
        }
        if latest_turn_id.as_deref() == Some(user_message.id.as_str()) {
            if let Some(attempt) = group.last() {
                latest_attempt_id = Some(attempt.id.clone());
                latest_attempt_status = Some(attempt.status.clone());
            }
        }
    }
    projected_messages.sort_by_key(|message| message.sequence);

    AIConversationProjectionCore {
        projected_messages,
        latest_turn_id,
        effective_assistant_message_id: latest_effective_message_id,
        effective_source_attempt_id: latest_effective_attempt_id,
        latest_attempt_id,
        latest_attempt_status,
        malformed_success_ignored,
    }
}

fn active_ai_attempt_exists_for_conversation(
    connection: &Connection,
    conversation_id: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM ai_call_attempts
               WHERE conversation_id=?1 AND status='started'
             )",
            [conversation_id],
            |row| row.get(0),
        )
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))
}

fn trigger_has_file_ref_authorization(
    connection: &Connection,
    conversation_id: &str,
    trigger_message_id: &str,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1
               FROM ai_call_attempts attempt
               JOIN ai_call_attempt_file_ref_authorizations authorization
                 ON authorization.call_attempt_id=attempt.id
               WHERE attempt.conversation_id=?1
                 AND attempt.trigger_message_id=?2
                 AND attempt.purpose='chat_response'
             )",
            params![conversation_id, trigger_message_id],
            |row| row.get(0),
        )
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))
}

fn retry_regenerate_projection(
    core: &AIConversationProjectionCore,
    attachment_reauthorization_required: bool,
    active_conflict: bool,
) -> AIRetryRegenerateProjection {
    AIRetryRegenerateProjection {
        latest_turn_id: core.latest_turn_id.clone(),
        effective_assistant_message_id: core.effective_assistant_message_id.clone(),
        effective_source_attempt_id: core.effective_source_attempt_id.clone(),
        latest_attempt_id: core.latest_attempt_id.clone(),
        latest_attempt_status: core.latest_attempt_status.clone(),
        retry_eligible: core.latest_attempt_status.as_deref() == Some("failed")
            && !attachment_reauthorization_required
            && !active_conflict,
        regenerate_eligible: core.effective_assistant_message_id.is_some()
            && core.effective_source_attempt_id.is_some()
            && !attachment_reauthorization_required
            && !active_conflict,
        attachment_reauthorization_required,
        active_conflict,
        safe_integrity_state: if core.malformed_success_ignored {
            "malformed_success_ignored".to_string()
        } else {
            "ok".to_string()
        },
    }
}

pub(crate) fn read_ai_conversation_in_connection(
    connection: &Connection,
    conversation_id: &str,
) -> Result<AIConversationReadback, String> {
    let conversation = read_conversation_record(connection, conversation_id)?;
    let messages = read_messages(connection, conversation_id)?;
    let call_attempts = read_call_attempts(connection, conversation_id)?;
    let context_requests = read_context_requests(connection, conversation_id)?;
    let standard_results = read_standard_results(connection, conversation_id)?;
    let core = project_effective_conversation(conversation_id, &messages, &call_attempts);
    let attachment_reauthorization_required = core
        .latest_turn_id
        .as_deref()
        .map(|trigger_message_id| {
            trigger_has_file_ref_authorization(connection, conversation_id, trigger_message_id)
        })
        .transpose()?
        .unwrap_or(false);
    let active_conflict = active_ai_attempt_exists_for_conversation(connection, conversation_id)?;
    let retry_regenerate = retry_regenerate_projection(
        &core,
        attachment_reauthorization_required,
        active_conflict,
    );
    Ok(AIConversationReadback {
        conversation,
        messages,
        projected_messages: core.projected_messages,
        call_attempts,
        context_requests,
        standard_results,
        retry_regenerate,
    })
}

fn next_sequence(
    connection: &Connection,
    table: &str,
    conversation_id: &str,
) -> Result<i64, String> {
    let sql = format!("SELECT COALESCE(MAX(sequence),0)+1 FROM {table} WHERE conversation_id=?1");
    connection
        .query_row(&sql, [conversation_id], |row| row.get(0))
        .map_err(|error| fail("AI_DURABLE_WRITE_FAILED", error.to_string()))
}

fn insert_message(
    connection: &Connection,
    conversation_id: &str,
    role: &str,
    input: &NewAIMessageInput,
) -> Result<AIMessageRecord, String> {
    require_text(&input.id, "message.id", 200)?;
    require_text(&input.content, "message.content", MAX_MESSAGE_CHARS)?;
    require_text(&input.created_at, "message.createdAt", 80)?;
    let sequence = next_sequence(connection, "ai_messages", conversation_id)?;
    connection
        .execute(
            "INSERT INTO ai_messages(id,conversation_id,sequence,role,content,created_at)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                input.id,
                conversation_id,
                sequence,
                role,
                input.content,
                input.created_at
            ],
        )
        .map_err(|error| fail("AI_DURABLE_WRITE_FAILED", error.to_string()))?;
    Ok(AIMessageRecord {
        id: input.id.clone(),
        conversation_id: conversation_id.to_string(),
        sequence,
        role: role.to_string(),
        content: input.content.clone(),
        message_kind: "text".to_string(),
        action_type: None,
        action_ref_id: None,
        created_at: input.created_at.clone(),
    })
}

fn insert_context_request_action_message(
    connection: &Connection,
    conversation_id: &str,
    message_id: &str,
    action_type: &str,
    context_request_id: &str,
    created_at: &str,
) -> Result<AIMessageRecord, String> {
    require_text(message_id, "actionMessageId", 200)?;
    require_text(context_request_id, "contextRequestId", 200)?;
    require_text(created_at, "action.createdAt", 80)?;
    if !matches!(action_type, "APPROVE_CONTEXT_REQUEST" | "REJECT_CONTEXT_REQUEST") {
        return Err(fail("AI_CONTEXT_REQUEST_ACTION_INVALID", "Unsupported Context Request action."));
    }
    let sequence = next_sequence(connection, "ai_messages", conversation_id)?;
    connection
        .execute(
            "INSERT INTO ai_messages(
               id,conversation_id,sequence,role,content,message_kind,action_type,action_ref_id,created_at
             ) VALUES (?1,?2,?3,'user',?4,'context_request_action',?4,?5,?6)",
            params![message_id, conversation_id, sequence, action_type, context_request_id, created_at],
        )
        .map_err(|error| fail("AI_DURABLE_PRE_PROVIDER_PERSISTENCE_FAILED", error.to_string()))?;
    Ok(AIMessageRecord {
        id: message_id.to_string(),
        conversation_id: conversation_id.to_string(),
        sequence,
        role: "user".to_string(),
        content: action_type.to_string(),
        message_kind: "context_request_action".to_string(),
        action_type: Some(action_type.to_string()),
        action_ref_id: Some(context_request_id.to_string()),
        created_at: created_at.to_string(),
    })
}

fn normalized_authorized_file_ref_ids(input: &[String]) -> Result<Vec<String>, String> {
    let mut ids = BTreeSet::new();
    for candidate in input {
        if candidate.is_empty()
            || candidate.trim() != candidate
            || candidate.chars().count() > 200
            || candidate.chars().any(char::is_control)
        {
            return Err(fail(
                "AI_ATTACHMENT_ID_INVALID",
                "A selected attachment no longer has a valid canonical FileRef identity.",
            ));
        }
        ids.insert(candidate.clone());
    }
    if ids.len() > MAX_AUTHORIZED_FILE_REFS_PER_CALL {
        return Err(fail(
            "AI_ATTACHMENT_COUNT_EXCEEDED",
            format!(
                "At most {MAX_AUTHORIZED_FILE_REFS_PER_CALL} FileRefs may be authorized for one AI call."
            ),
        ));
    }
    Ok(ids.into_iter().collect())
}

fn resolve_authorized_file_refs(
    connection: &Connection,
    ids: &[String],
) -> Result<Vec<AIAuthorizedFileRefSnapshot>, String> {
    let configured_root = read_managed_root(connection)?;
    let mut resolved = Vec::with_capacity(ids.len());
    for id in ids {
        let record: Option<(String, String, String, String, String)> = connection
            .query_row(
                "SELECT title,resource_kind,file_type,path,location_mode
                 FROM file_refs WHERE id=?1 AND deleted_at IS NULL",
                [id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
        let Some((title, resource_kind, file_type, path, location_mode)) = record else {
            return Err(fail(
                "AI_ATTACHMENT_ID_INVALID",
                "A selected attachment is no longer an active canonical FileRef.",
            ));
        };
        let display_name = safe_display_name(&title, &path);
        if resource_kind != "file" {
            return Err(fail(
                "AI_ATTACHMENT_REFERENCE_KIND_UNSUPPORTED",
                format!("Attachment \"{display_name}\" is a directory and cannot be authorized."),
            ));
        }
        if file_availability(
            &resource_kind,
            &path,
            &location_mode,
            true,
            configured_root.as_deref(),
        ) != "available"
        {
            return Err(fail(
                "AI_ATTACHMENT_UNAVAILABLE",
                format!("Attachment \"{display_name}\" is unavailable or no longer a file."),
            ));
        }
        resolved.push(AIAuthorizedFileRefSnapshot {
            file_ref_id: id.clone(),
            display_name,
            resource_kind,
            file_type: safe_file_type(&file_type),
            availability_status: "available".to_string(),
        });
    }
    Ok(resolved)
}

fn insert_authorized_file_refs(
    connection: &Connection,
    attempt_id: &str,
    authorized_at: &str,
    snapshots: &[AIAuthorizedFileRefSnapshot],
) -> Result<(), String> {
    for snapshot in snapshots {
        connection
            .execute(
                "INSERT INTO ai_call_attempt_file_ref_authorizations(
                   call_attempt_id,file_ref_id,display_name,resource_kind,file_type,authorized_at
                 ) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    attempt_id,
                    snapshot.file_ref_id,
                    snapshot.display_name,
                    snapshot.resource_kind,
                    snapshot.file_type,
                    authorized_at,
                ],
            )
            .map_err(|error| {
                fail(
                    "AI_DURABLE_PRE_PROVIDER_PERSISTENCE_FAILED",
                    error.to_string(),
                )
            })?;
    }
    Ok(())
}

pub(crate) fn list_selectable_file_refs_in_connection(
    connection: &Connection,
) -> Result<Vec<AISelectableFileRef>, String> {
    let configured_root = read_managed_root(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT id,title,resource_kind,file_type,path,location_mode
             FROM file_refs WHERE deleted_at IS NULL
             ORDER BY id ASC",
        )
        .map_err(|error| fail("AI_ATTACHMENT_SELECTOR_READ_FAILED", error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            let file_ref_id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let resource_kind: String = row.get(2)?;
            let file_type: String = row.get(3)?;
            let path: String = row.get(4)?;
            let location_mode: String = row.get(5)?;
            let availability = if resource_kind != "file" {
                "unsupported_kind"
            } else {
                file_availability(
                    &resource_kind,
                    &path,
                    &location_mode,
                    true,
                    configured_root.as_deref(),
                )
            };
            let mut material_read_status = if resource_kind == "file"
                && availability == "available"
                && is_supported_ai_material_path(&path)
            {
                "supported"
            } else if resource_kind != "file" {
                "unsupported_kind"
            } else if availability != "available" {
                "unavailable"
            } else {
                "unsupported_type"
            };
            let canonical_material_path = if material_read_status == "supported" {
                let configured_root = if location_mode == "managed" {
                    configured_root.as_deref()
                } else {
                    None
                };
                crate::native_open::canonical_path_for_available_resource(
                    &path,
                    "file",
                    configured_root,
                )
            } else {
                None
            };
            let material_prompt_reservation_characters =
                canonical_material_path.as_deref().and_then(
                    crate::authorized_material::estimate_material_prompt_reservation_characters,
                );
            let material_freshness_receipt =
                canonical_material_path
                    .as_deref()
                    .and_then(|canonical_path| {
                        crate::authorized_material::inspect_material_freshness_receipt(
                            canonical_path,
                            &file_ref_id,
                        )
                    });
            if material_read_status == "supported" && material_freshness_receipt.is_none() {
                material_read_status = "unavailable";
            }
            Ok(AISelectableFileRef {
                file_ref_id,
                display_name: safe_display_name(&title, &path),
                resource_kind,
                file_type: safe_file_type(&file_type),
                availability_status: availability.to_string(),
                material_read_status: material_read_status.to_string(),
                material_prompt_reservation_characters,
                material_freshness_receipt,
            })
        })
        .map_err(|error| fail("AI_ATTACHMENT_SELECTOR_READ_FAILED", error.to_string()))?;
    let mut result = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| fail("AI_ATTACHMENT_SELECTOR_READ_FAILED", error.to_string()))?;
    result.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.file_ref_id.cmp(&right.file_ref_id))
    });
    Ok(result)
}

fn validate_prepare_input(input: &PrepareAICallAttemptInput) -> Result<(), String> {
    for (value, field, max) in [
        (&input.conversation_id, "conversationId", 200),
        (&input.attempt_id, "attemptId", 200),
        (&input.request_id, "requestId", 200),
        (&input.purpose, "purpose", 40),
        (&input.provider, "provider", 120),
        (&input.model, "model", 200),
        (&input.context_package_id, "contextPackageId", 200),
        (&input.context_package_version, "contextPackageVersion", 120),
        (&input.prompt_package_id, "promptPackageId", 200),
        (&input.prompt_created_at, "promptCreatedAt", 80),
        (&input.started_at, "startedAt", 80),
    ] {
        require_text(value, field, max)?;
    }
    if !matches!(
        input.purpose.as_str(),
        "chat_response" | "action_draft_generation" | "parse_draft"
    ) {
        return Err(fail("AI_DURABLE_INPUT_INVALID", "unsupported purpose"));
    }
    if !input.context_source_refs.is_array() || !input.warnings.is_array() {
        return Err(fail(
            "AI_DURABLE_INPUT_INVALID",
            "contextSourceRefs and warnings must be arrays",
        ));
    }
    json_text(&input.context_source_refs, "contextSourceRefs")?;
    validate_a3_constraint_source_refs(&input.context_source_refs, &input.purpose)?;
    json_text(&input.warnings, "warnings")?;
    optional_json_text(&input.budget_summary, "budgetSummary")?;
    let authorized_file_ref_ids =
        normalized_authorized_file_ref_ids(&input.authorized_file_ref_ids)?;
    match input.purpose.as_str() {
        "chat_response" if input.user_message.is_none() => Err(fail(
            "AI_DURABLE_INPUT_INVALID",
            "chat_response requires a new user message",
        )),
        "action_draft_generation"
            if input.user_message.is_some()
                || input
                    .trigger_message_id
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                || input
                    .trigger_call_attempt_id
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty() =>
        {
            Err(fail(
                "AI_DURABLE_INPUT_INVALID",
                "action_draft_generation requires durable source message and attempt correlations",
            ))
        }
        "action_draft_generation" if !authorized_file_ref_ids.is_empty() => Err(fail(
            "AI_ATTACHMENT_PURPOSE_INVALID",
            "Action Draft generation cannot acquire a new FileRef authorization set.",
        )),
        "parse_draft"
            if input.user_message.is_some()
                || input
                    .trigger_message_id
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty() =>
        {
            Err(fail(
                "AI_DURABLE_INPUT_INVALID",
                "parse_draft requires one existing durable trigger Message and no new user Message",
            ))
        }
        _ => Ok(()),
    }
}

fn is_a3_constraint_source_ref(value: &Value) -> bool {
    value.get("field").and_then(Value::as_str) == Some("constraintDescriptor")
        || value.get("constraintCategory").is_some()
        || value.get("constraintLifecycle").is_some()
        || value.get("constraintRef").is_some()
        || value.get("constraintVersion").is_some()
        || value.get("sharedInvariantRef").is_some()
        || value.get("sharedInvariantVersion").is_some()
        || value.get("boundedPolicyRefs").is_some()
        || value.get("boundedPolicyDocuments").is_some()
        || value.get("legacySourceMarker").is_some()
}

fn a3_constraint_source_ref(value: &Value) -> Result<Option<&Value>, String> {
    let values = value.as_array().ok_or_else(|| {
        fail(
            "AI_CONSTRAINT_PROVENANCE_INVALID",
            "contextSourceRefs must be an array for constraint correlation",
        )
    })?;
    let candidates = values
        .iter()
        .filter(|source_ref| is_a3_constraint_source_ref(source_ref))
        .collect::<Vec<_>>();
    if candidates.len() > 1 {
        return Err(fail(
            "AI_CONSTRAINT_PROVENANCE_INVALID",
            "covered calls must carry exactly one constraint descriptor",
        ));
    }
    Ok(candidates.into_iter().next())
}

fn validate_a3_constraint_source_refs(value: &Value, purpose: &str) -> Result<(), String> {
    let candidate = a3_constraint_source_ref(value)?;
    if purpose == "action_draft_generation" {
        return if candidate.is_none() {
            Ok(())
        } else {
            Err(fail(
                "AI_CONSTRAINT_PURPOSE_INCOMPATIBLE",
                "action_draft_generation is outside A3 descriptor coverage",
            ))
        };
    }
    let source_ref = candidate.ok_or_else(|| {
        fail(
            "AI_CONSTRAINT_DESCRIPTOR_MISSING",
            "covered calls require one frozen ACTIVE constraint descriptor",
        )
    })?;
    let category = source_ref
        .get("constraintCategory")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let bounded_policy_refs = source_ref
        .get("boundedPolicyRefs")
        .and_then(Value::as_array);
    let existing_constraint_identity_valid = |expected_ref: &str| {
        source_ref.get("constraintRef").and_then(Value::as_str) == Some(expected_ref)
            && source_ref
                .get("constraintVersion")
                .and_then(Value::as_u64)
                .is_some_and(|version| version > 0)
            && source_ref
                .get("sharedInvariantRef")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
            && source_ref
                .get("sharedInvariantVersion")
                .and_then(Value::as_u64)
                .is_some_and(|version| version > 0)
    };
    let descriptor_identity_valid = match (purpose, category) {
        ("chat_response", "NORMAL_QA") => {
            existing_constraint_identity_valid("labpod.ai.constraint.normal_qa")
                && bounded_policy_refs.is_some_and(|refs| {
                    !refs.is_empty()
                        && refs
                            .iter()
                            .all(|item| item.as_str().is_some_and(|text| !text.trim().is_empty()))
                })
        }
        ("parse_draft", "PARSE_DRAFT") => {
            existing_constraint_identity_valid("labpod.ai.constraint.parse_draft")
                && bounded_policy_refs.is_some_and(|refs| {
                    refs.iter()
                        .all(|item| item.as_str().is_some_and(|text| !text.trim().is_empty()))
                })
        }
        ("chat_response", "QUICK_ANALYSIS") => {
            source_ref.get("constraintRef").and_then(Value::as_str)
                == Some("labpod.ai.constraint.quick_analysis")
                && source_ref
                    .get("constraintVersion")
                    .and_then(Value::as_u64)
                    .is_some_and(|version| matches!(version, 2 | 3 | 4))
                && source_ref.get("sharedInvariantRef").and_then(Value::as_str)
                    == Some("labpod.ai.constraint.shared_invariant")
                && source_ref.get("sharedInvariantVersion").and_then(Value::as_u64) == Some(2)
                && bounded_policy_refs.is_some_and(Vec::is_empty)
        }
        _ => false,
    };
    let legacy_marker_valid = source_ref
        .get("legacySourceMarker")
        .map(|value| value.as_str() == Some("PRE_A3_ORDINARY_CHAT_SOURCE"))
        .unwrap_or(true);
    let objective_outline_policy_target_valid = value.as_array().is_some_and(|refs| {
        let receipts = refs.iter().filter(|source_ref| {
            source_ref.get("field").and_then(Value::as_str)
                == Some("quickAnalysisRunAuthorization")
        }).collect::<Vec<_>>();
        receipts.len() == 1
            && receipts[0].get("quickAnalysisOwnerType").and_then(Value::as_str)
                == Some("literature")
            && receipts[0].get("quickAnalysisChannel").and_then(Value::as_str)
                == Some("literature_outline")
    });
    let simple_quick_target_valid = if matches!((purpose, category), ("chat_response", "QUICK_ANALYSIS")) {
        match source_ref.get("constraintVersion").and_then(Value::as_u64) {
            Some(3) => !objective_outline_policy_target_valid,
            Some(4) => objective_outline_policy_target_valid,
            _ => true,
        }
    } else {
        true
    };
    let bounded_policy_documents_valid = source_ref
        .get("boundedPolicyDocuments")
        .map(|value| {
            value.as_array().is_some_and(|documents| {
                documents.len() <= 1
                    && documents.iter().all(|document| {
                        let identity = (
                            document.get("documentId").and_then(Value::as_str),
                            document.get("semanticVersion").and_then(Value::as_u64),
                        );
                        matches!(
                            identity,
                            (Some("labpod.ai.policy.context_request"), Some(3 | 4 | 5))
                        )
                            || (identity
                                == (
                                    Some("labpod.ai.policy.parse_semantic_correction"),
                                    Some(1),
                                )
                                && matches!((purpose, category), ("parse_draft", "PARSE_DRAFT")))
                            || (identity
                                == (
                                    Some("labpod.ai.policy.literature_objective_outline"),
                                    Some(1),
                                )
                                && matches!(
                                    (purpose, category),
                                    ("chat_response", "QUICK_ANALYSIS")
                                        | ("parse_draft", "PARSE_DRAFT")
                                )
                                && objective_outline_policy_target_valid)
                    })
            })
        })
        .unwrap_or(true);
    if source_ref.get("constraintLifecycle").and_then(Value::as_str) != Some("ACTIVE")
        || !descriptor_identity_valid
        || !bounded_policy_documents_valid
        || !simple_quick_target_valid
        || !legacy_marker_valid
    {
        return Err(fail(
            "AI_CONSTRAINT_PROVENANCE_INVALID",
            "covered CallAttempt constraint provenance is incomplete or incompatible",
        ));
    }
    Ok(())
}

fn assert_idempotent_prepare(
    connection: &Connection,
    existing: &AICallAttemptRecord,
    input: &PrepareAICallAttemptInput,
) -> Result<(), String> {
    let expected_trigger_message_id = if input.purpose == "chat_response" {
        input
            .user_message
            .as_ref()
            .map(|message| message.id.as_str())
    } else {
        input.trigger_message_id.as_deref()
    };
    let budget_matches = existing.budget_summary == input.budget_summary;
    let expected_file_ref_ids = normalized_authorized_file_ref_ids(&input.authorized_file_ref_ids)?;
    let existing_file_ref_ids = existing
        .authorized_file_refs
        .iter()
        .map(|snapshot| snapshot.file_ref_id.clone())
        .collect::<Vec<_>>();
    if existing.id != input.attempt_id
        || existing.conversation_id != input.conversation_id
        || existing.purpose != input.purpose
        || existing.trigger_message_id.as_deref() != expected_trigger_message_id
        || existing.trigger_call_attempt_id.as_deref() != input.trigger_call_attempt_id.as_deref()
        || existing.provider != input.provider
        || existing.model != input.model
        || existing.context_package_id != input.context_package_id
        || existing.context_package_version != input.context_package_version
        || existing.context_source_refs != input.context_source_refs
        || existing.warnings != input.warnings
        || !budget_matches
        || existing.prompt_package_id != input.prompt_package_id
        || existing.prompt_created_at != input.prompt_created_at
        || existing_file_ref_ids != expected_file_ref_ids
    {
        return Err(fail(
            "AI_DURABLE_IDEMPOTENCY_CONFLICT",
            "request identity was replayed with different call facts",
        ));
    }
    if let Some(user_message) = &input.user_message {
        let durable_message = connection
            .query_row(
                "SELECT role,content,created_at FROM ai_messages WHERE id=?1",
                [&user_message.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
        if durable_message.0 != "user" || durable_message.1 != user_message.content {
            return Err(fail(
                "AI_DURABLE_IDEMPOTENCY_CONFLICT",
                "request identity was replayed with a different user message",
            ));
        }
    }
    Ok(())
}

fn validate_action_draft_trigger(
    connection: &Connection,
    conversation_id: &str,
    message_id: &str,
    attempt_id: &str,
) -> Result<(), String> {
    let messages = read_messages(connection, conversation_id)?;
    let attempts = read_call_attempts_without_authorizations(connection, conversation_id)?;
    let projection = project_effective_conversation(conversation_id, &messages, &attempts);
    if projection.effective_assistant_message_id.as_deref() != Some(message_id)
        || projection.effective_source_attempt_id.as_deref() != Some(attempt_id)
    {
        return Err(fail(
            "AI_DURABLE_TRIGGER_INVALID",
            "Action Draft trigger is not the current effective durable chat response",
        ));
    }
    Ok(())
}

fn validate_parse_draft_trigger(
    connection: &Connection,
    conversation_id: &str,
    message_id: &str,
    context_source_refs: &Value,
) -> Result<(), String> {
    let message: Option<(String, String)> = connection
        .query_row(
            "SELECT role,message_kind FROM ai_messages WHERE id=?1 AND conversation_id=?2",
            params![message_id, conversation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    if message.as_ref().map(|value| (value.0.as_str(), value.1.as_str()))
        != Some(("user", "text"))
    {
        return Err(fail(
            "AI_PARSE_DRAFT_TRIGGER_INVALID",
            "Parse Draft requires an existing durable user text Message trigger",
        ));
    }
    let parse_refs = context_source_refs
        .as_array()
        .into_iter()
        .flatten()
        .filter(|source_ref| {
            source_ref.get("field").and_then(Value::as_str)
                == Some("relevantEffectiveDiscussion")
        })
        .collect::<Vec<_>>();
    if parse_refs.len() != 1
        || !parse_refs[0]
            .get("parseDiscussionFingerprint")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        || !parse_refs[0]
            .get("parseDiscussionMessageIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.iter().any(|value| value.as_str() == Some(message_id)))
    {
        return Err(fail(
            "AI_PARSE_DRAFT_SOURCE_INVALID",
            "Parse Draft requires one frozen relevant-effective-discussion source containing its trigger",
        ));
    }
    Ok(())
}

pub(crate) fn prepare_ai_call_attempt_in_connection(
    connection: &mut Connection,
    input: &PrepareAICallAttemptInput,
) -> Result<PreparedAICallAttempt, String> {
    validate_prepare_input(input)?;
    let normalized_file_ref_ids =
        normalized_authorized_file_ref_ids(&input.authorized_file_ref_ids)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            fail(
                "AI_DURABLE_PRE_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;

    if let Some(existing) = read_call_attempt_by_request_id(&transaction, &input.request_id)? {
        assert_idempotent_prepare(&transaction, &existing, input)?;
        transaction.commit().map_err(|error| {
            fail(
                "AI_DURABLE_PRE_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
        return Ok(PreparedAICallAttempt {
            provider_invocation_authorized: false,
            readback: read_ai_conversation_in_connection(connection, &input.conversation_id)?,
        });
    }
    read_conversation_record(&transaction, &input.conversation_id).map_err(|_| {
        fail(
            "AI_DURABLE_CONVERSATION_REQUIRED",
            "selected canonical Conversation must exist before provider pre-gate",
        )
    })?;
    let authorized_file_refs =
        resolve_authorized_file_refs(&transaction, &normalized_file_ref_ids)?;

    let trigger_message_id = if input.purpose == "chat_response" {
        let user_message = input.user_message.as_ref().expect("validated user message");
        insert_message(&transaction, &input.conversation_id, "user", user_message)?.id
    } else if input.purpose == "action_draft_generation" {
        let message_id = input
            .trigger_message_id
            .as_deref()
            .expect("validated trigger message");
        let attempt_id = input
            .trigger_call_attempt_id
            .as_deref()
            .expect("validated trigger attempt");
        validate_action_draft_trigger(&transaction, &input.conversation_id, message_id, attempt_id)?;
        message_id.to_string()
    } else {
        let message_id = input
            .trigger_message_id
            .as_deref()
            .expect("validated Parse Draft trigger message");
        validate_parse_draft_trigger(
            &transaction,
            &input.conversation_id,
            message_id,
            &input.context_source_refs,
        )?;
        message_id.to_string()
    };

    let attempt_sequence =
        next_sequence(&transaction, "ai_call_attempts", &input.conversation_id)?;
    let source_refs_json = json_text(&input.context_source_refs, "contextSourceRefs")?;
    let warnings_json = json_text(&input.warnings, "warnings")?;
    let budget_json = optional_json_text(&input.budget_summary, "budgetSummary")?;
    transaction
        .execute(
            "INSERT INTO ai_call_attempts(
               id,request_id,conversation_id,sequence,purpose,trigger_message_id,
               trigger_call_attempt_id,result_message_id,provider,model,status,
               context_package_id,context_package_version,context_source_refs_json,warnings_json,
               budget_summary_json,prompt_package_id,prompt_created_at,started_at
             ) VALUES (
               ?1,?2,?3,?4,?5,?6,?7,NULL,?8,?9,'started',?10,?11,?12,?13,?14,?15,?16,?17
             )",
            params![
                input.attempt_id,
                input.request_id,
                input.conversation_id,
                attempt_sequence,
                input.purpose,
                trigger_message_id,
                input.trigger_call_attempt_id,
                input.provider,
                input.model,
                input.context_package_id,
                input.context_package_version,
                source_refs_json,
                warnings_json,
                budget_json,
                input.prompt_package_id,
                input.prompt_created_at,
                input.started_at,
            ],
        )
        .map_err(|error| {
            fail(
                "AI_DURABLE_PRE_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
    insert_authorized_file_refs(
        &transaction,
        &input.attempt_id,
        &input.started_at,
        &authorized_file_refs,
    )?;
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.started_at, input.conversation_id],
        )
        .map_err(|error| {
            fail(
                "AI_DURABLE_PRE_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
    transaction.commit().map_err(|error| {
        fail(
            "AI_DURABLE_PRE_PROVIDER_PERSISTENCE_FAILED",
            error.to_string(),
        )
    })?;

    Ok(PreparedAICallAttempt {
        provider_invocation_authorized: true,
        readback: read_ai_conversation_in_connection(connection, &input.conversation_id)?,
    })
}

fn validate_retry_regenerate_prepare_input(
    input: &PrepareAIRetryRegenerateAttemptInput,
) -> Result<(), String> {
    for (value, field, max) in [
        (&input.conversation_id, "conversationId", 200),
        (&input.attempt_id, "attemptId", 200),
        (&input.request_id, "requestId", 200),
        (&input.trigger_message_id, "triggerMessageId", 200),
        (&input.expected_source_attempt_id, "expectedSourceAttemptId", 200),
        (&input.provider, "provider", 120),
        (&input.model, "model", 200),
        (&input.context_package_id, "contextPackageId", 200),
        (&input.context_package_version, "contextPackageVersion", 120),
        (&input.prompt_package_id, "promptPackageId", 200),
        (&input.prompt_created_at, "promptCreatedAt", 80),
        (&input.started_at, "startedAt", 80),
    ] {
        require_text(value, field, max)?;
    }
    if input.attempt_id != input.request_id {
        return Err(fail(
            "attempt_identity_conflict",
            "Retry/Regenerate requires one canonical CallAttempt/request identity.",
        ));
    }
    match input.action_intent {
        AIChatAttemptActionIntent::Retry if input.expected_effective_message_id.is_some() => {
            return Err(fail(
                "retry_regenerate_not_eligible",
                "Retry cannot bind an effective assistant result.",
            ));
        }
        AIChatAttemptActionIntent::Regenerate => {
            require_text(
                input.expected_effective_message_id.as_deref().unwrap_or(""),
                "expectedEffectiveMessageId",
                200,
            )?;
        }
        _ => {}
    }
    if !input.context_source_refs.is_array() || !input.warnings.is_array() {
        return Err(fail(
            "retry_regenerate_prepare_failed",
            "Retry/Regenerate context provenance is invalid.",
        ));
    }
    json_text(&input.context_source_refs, "contextSourceRefs")?;
    validate_a3_constraint_source_refs(&input.context_source_refs, "chat_response")?;
    json_text(&input.warnings, "warnings")?;
    optional_json_text(&input.budget_summary, "budgetSummary")?;
    Ok(())
}

fn retry_regenerate_prepare_identity_matches(
    existing: &AICallAttemptRecord,
    input: &PrepareAIRetryRegenerateAttemptInput,
) -> bool {
    existing.id == input.attempt_id
        && existing.request_id == input.request_id
        && existing.conversation_id == input.conversation_id
        && existing.purpose == "chat_response"
        && existing.trigger_message_id.as_deref() == Some(input.trigger_message_id.as_str())
        && existing.trigger_call_attempt_id.as_deref()
            == Some(input.expected_source_attempt_id.as_str())
        && existing.provider == input.provider
        && existing.model == input.model
        && existing.context_package_id == input.context_package_id
        && existing.context_package_version == input.context_package_version
        && existing.context_source_refs == input.context_source_refs
        && existing.warnings == input.warnings
        && existing.budget_summary == input.budget_summary
        && existing.prompt_package_id == input.prompt_package_id
        && existing.prompt_created_at == input.prompt_created_at
}

fn validate_retry_constraint_inheritance(
    source_attempt: &AICallAttemptRecord,
    new_source_refs: &Value,
) -> Result<(), String> {
    let source = a3_constraint_source_ref(&source_attempt.context_source_refs)?;
    let next = a3_constraint_source_ref(new_source_refs)?.ok_or_else(|| {
        fail(
            "AI_CONSTRAINT_DESCRIPTOR_MISSING",
            "Retry/Regenerate requires a frozen descriptor on the new attempt",
        )
    })?;
    if let Some(source) = source {
        for field in [
            "constraintCategory",
            "constraintLifecycle",
            "constraintRef",
            "constraintVersion",
            "constraintContentHash",
            "sharedInvariantRef",
            "sharedInvariantVersion",
            "sharedInvariantContentHash",
            "boundedPolicyRefs",
            "boundedPolicyDocuments",
            "boundedPolicyContentHash",
        ] {
            if source.get(field) != next.get(field) {
                return Err(fail(
                    "AI_CONSTRAINT_RETRY_INHERITANCE_INVALID",
                    "Retry/Regenerate cannot silently change the source constraint descriptor",
                ));
            }
        }
    } else if next.get("legacySourceMarker").and_then(Value::as_str)
        != Some("PRE_A3_ORDINARY_CHAT_SOURCE")
    {
        return Err(fail(
            "AI_CONSTRAINT_LEGACY_SOURCE_MARKER_MISSING",
            "A retry from a legacy ordinary source must mark the new A3-native attempt",
        ));
    }
    Ok(())
}

pub(crate) fn prepare_ai_retry_regenerate_attempt_in_connection(
    connection: &mut Connection,
    input: &PrepareAIRetryRegenerateAttemptInput,
) -> Result<PreparedAICallAttempt, String> {
    validate_retry_regenerate_prepare_input(input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| {
            fail(
                "retry_regenerate_prepare_failed",
                "Retry/Regenerate could not acquire the canonical prepare transaction.",
            )
        })?;

    if let Some(existing) =
        read_call_attempt_by_id_without_authorizations(&transaction, &input.attempt_id)?
    {
        if !retry_regenerate_prepare_identity_matches(&existing, input) {
            return Err(fail(
                "attempt_identity_conflict",
                "The proposed CallAttempt identity is already bound to different canonical facts.",
            ));
        }
        let provider_invocation_authorized = existing.status == "started";
        transaction.commit().map_err(|_| {
            fail(
                "retry_regenerate_prepare_failed",
                "Retry/Regenerate authoritative replay could not be completed.",
            )
        })?;
        return Ok(PreparedAICallAttempt {
            provider_invocation_authorized,
            readback: read_ai_conversation_in_connection(connection, &input.conversation_id)?,
        });
    }
    if read_call_attempt_by_request_id(&transaction, &input.request_id)?.is_some() {
        return Err(fail(
            "attempt_identity_conflict",
            "The proposed request identity is already bound to another CallAttempt.",
        ));
    }

    read_conversation_record(&transaction, &input.conversation_id).map_err(|_| {
        fail(
            "retry_regenerate_not_latest",
            "The selected canonical Conversation is unavailable.",
        )
    })?;
    let messages = read_messages(&transaction, &input.conversation_id)?;
    let attempts =
        read_call_attempts_without_authorizations(&transaction, &input.conversation_id)?;
    let projection = project_effective_conversation(&input.conversation_id, &messages, &attempts);
    if projection.latest_turn_id.as_deref() != Some(input.trigger_message_id.as_str()) {
        return Err(fail(
            "retry_regenerate_not_latest",
            "Retry/Regenerate is limited to the latest canonical user turn.",
        ));
    }

    match input.action_intent {
        AIChatAttemptActionIntent::Retry => {
            if projection.latest_attempt_id.as_deref()
                != Some(input.expected_source_attempt_id.as_str())
                || projection.latest_attempt_status.as_deref() != Some("failed")
            {
                return Err(fail(
                    "retry_regenerate_not_eligible",
                    "The expected failed or cancelled CallAttempt is no longer the latest attempt.",
                ));
            }
        }
        AIChatAttemptActionIntent::Regenerate => {
            if projection.effective_source_attempt_id.as_deref()
                != Some(input.expected_source_attempt_id.as_str())
                || projection.effective_assistant_message_id.as_deref()
                    != input.expected_effective_message_id.as_deref()
            {
                return Err(fail(
                    "retry_regenerate_not_eligible",
                    "The expected assistant result is no longer the canonical effective result.",
                ));
            }
        }
    }
    let source_attempt = attempts
        .iter()
        .find(|attempt| attempt.id == input.expected_source_attempt_id)
        .ok_or_else(|| {
            fail(
                "retry_regenerate_not_eligible",
                "The expected source CallAttempt is unavailable.",
            )
        })?;
    validate_retry_constraint_inheritance(source_attempt, &input.context_source_refs)?;
    if active_ai_attempt_exists_for_conversation(&transaction, &input.conversation_id)? {
        return Err(fail(
            "retry_regenerate_active_conflict",
            "Another canonical AI invocation is already active.",
        ));
    }
    if trigger_has_file_ref_authorization(
        &transaction,
        &input.conversation_id,
        &input.trigger_message_id,
    )? {
        return Err(fail(
            "retry_regenerate_attachment_reauthorization_required",
            "This user turn used local material. Select current materials and send a new message instead.",
        ));
    }

    let attempt_sequence =
        next_sequence(&transaction, "ai_call_attempts", &input.conversation_id)?;
    let source_refs_json = json_text(&input.context_source_refs, "contextSourceRefs")?;
    let warnings_json = json_text(&input.warnings, "warnings")?;
    let budget_json = optional_json_text(&input.budget_summary, "budgetSummary")?;
    transaction
        .execute(
            "INSERT INTO ai_call_attempts(
               id,request_id,conversation_id,sequence,purpose,trigger_message_id,
               trigger_call_attempt_id,result_message_id,provider,model,status,
               context_package_id,context_package_version,context_source_refs_json,warnings_json,
               budget_summary_json,prompt_package_id,prompt_created_at,started_at
               ) VALUES (
                ?1,?2,?3,?4,'chat_response',?5,?6,NULL,?7,?8,'started',
                ?9,?10,?11,?12,?13,?14,?15,?16
               )",
            params![
                input.attempt_id,
                input.request_id,
                input.conversation_id,
                attempt_sequence,
                input.trigger_message_id,
                input.expected_source_attempt_id,
                input.provider,
                input.model,
                input.context_package_id,
                input.context_package_version,
                source_refs_json,
                warnings_json,
                budget_json,
                input.prompt_package_id,
                input.prompt_created_at,
                input.started_at,
            ],
        )
        .map_err(|_| {
            fail(
                "retry_regenerate_prepare_failed",
                "Retry/Regenerate could not create the canonical CallAttempt.",
            )
        })?;
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.started_at, input.conversation_id],
        )
        .map_err(|_| {
            fail(
                "retry_regenerate_prepare_failed",
                "Retry/Regenerate could not update the canonical Conversation.",
            )
        })?;
    transaction.commit().map_err(|_| {
        fail(
            "retry_regenerate_prepare_failed",
            "Retry/Regenerate canonical preparation could not be committed.",
        )
    })?;

    Ok(PreparedAICallAttempt {
        provider_invocation_authorized: true,
        readback: read_ai_conversation_in_connection(connection, &input.conversation_id)?,
    })
}

fn context_request_for_conversation(
    connection: &Connection,
    conversation_id: &str,
    context_request_id: &str,
) -> Result<AIContextRequestRecord, String> {
    read_context_requests(connection, conversation_id)?
        .into_iter()
        .find(|request| request.id == context_request_id)
        .ok_or_else(|| {
            fail(
                "AI_CONTEXT_REQUEST_NOT_FOUND",
                "The canonical Context Request is unavailable in this Conversation",
            )
        })
}

fn context_request_body_file_ref_ids(candidates: &Value) -> Result<Vec<String>, String> {
    let values = value_array(candidates, "contextRequest.reviewedCandidates", 1, 8)?;
    let mut ids = BTreeSet::new();
    for candidate in values {
        let object = candidate.as_object().ok_or_else(|| {
            fail(
                "AI_CONTEXT_REQUEST_INVALID",
                "A reviewed Context Request candidate is malformed",
            )
        })?;
        if object.get("availability").and_then(Value::as_str) != Some("available") {
            return Err(fail(
                "AI_CONTEXT_REQUEST_CANDIDATE_UNAVAILABLE",
                "An unavailable Context Request candidate cannot be approved",
            ));
        }
        let ref_kind = object.get("refKind").and_then(Value::as_str);
        let contribution_kind = object.get("contributionKind").and_then(Value::as_str);
        let ref_id = object.get("refId").and_then(Value::as_str).unwrap_or("");
        if !matches!(ref_kind, Some("AI_RESEARCH_OBJECT" | "FILE_REF"))
            || !matches!(contribution_kind, Some("IDENTITY_METADATA" | "BODY_CONTENT"))
            || ref_id.trim().is_empty()
            || ref_id.trim() != ref_id
            || ref_id.chars().count() > 200
        {
            return Err(fail(
                "AI_CONTEXT_REQUEST_INVALID",
                "A reviewed Context Request candidate has an invalid canonical identity",
            ));
        }
        if contribution_kind == Some("BODY_CONTENT") {
            if ref_kind != Some("FILE_REF")
                || object.get("fileBodyAuthorizationRequired").and_then(Value::as_bool)
                    != Some(true)
            {
                return Err(fail(
                    "AI_CONTEXT_REQUEST_CONTRIBUTION_UNSUPPORTED",
                    "BODY_CONTENT is supported only through explicit FileRef authorization",
                ));
            }
            ids.insert(ref_id.to_string());
        }
    }
    Ok(ids.into_iter().collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QuickRunAuthorizationScope {
    run_id: String,
    authorization_source: String,
    project_id: String,
    owner_type: String,
    owner_id: String,
    channel: String,
    source_file_ref_id: String,
    source_directory_file_ref_id: String,
    whitelist_fingerprint: String,
    remaining: u64,
    capability_state: String,
}

fn quick_run_authorization_scope(
    source_refs: &Value,
) -> Result<Option<QuickRunAuthorizationScope>, String> {
    let refs = source_refs.as_array().ok_or_else(|| {
        fail(
            "AI_CONTEXT_REQUEST_FOLLOWUP_INVALID",
            "Context Request follow-up provenance must be an array",
        )
    })?;
    let candidates = refs
        .iter()
        .filter(|source_ref| {
            source_ref.get("field").and_then(Value::as_str) == Some("quickAnalysisRunAuthorization")
        })
        .collect::<Vec<_>>();
    if candidates.len() > 1 {
        return Err(fail(
            "AI_CONTEXT_REQUEST_SOURCE_STALE",
            "Quick Analysis follow-up provenance contains more than one run authorization receipt",
        ));
    }
    let Some(receipt) = candidates.first().copied() else {
        return Ok(None);
    };
    let required = |field: &str| {
        receipt
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.trim() == *value)
            .map(str::to_string)
            .ok_or_else(|| {
                fail(
                    "AI_CONTEXT_REQUEST_SOURCE_STALE",
                    "Quick Analysis run authorization provenance is incomplete",
                )
            })
    };
    let run_id = required("quickAnalysisRunId")?;
    let remaining = receipt
        .get("quickAnalysisAutoContextBudgetRemaining")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            fail(
                "AI_CONTEXT_REQUEST_SOURCE_STALE",
                "Quick Analysis run authorization budget provenance is incomplete",
            )
        })?;
    let capability_state = required("quickAnalysisContextCapabilityState")?;
    let scope = QuickRunAuthorizationScope {
        run_id: run_id.clone(),
        authorization_source: required("quickAnalysisAuthorizationSource")?,
        project_id: required("quickAnalysisProjectId")?,
        owner_type: required("quickAnalysisOwnerType")?,
        owner_id: required("quickAnalysisOwnerId")?,
        channel: required("quickAnalysisChannel")?,
        source_file_ref_id: required("quickAnalysisSourceFileRefId")?,
        source_directory_file_ref_id: required("quickAnalysisSourceDirectoryFileRefId")?,
        whitelist_fingerprint: required("quickAnalysisWhitelistFingerprint")?,
        remaining,
        capability_state,
    };
    if receipt.get("module").and_then(Value::as_str) != Some("ai")
        || receipt.get("entityType").and_then(Value::as_str) != Some("system")
        || receipt.get("entityId").and_then(Value::as_str) != Some(run_id.as_str())
        || receipt.get("sourceKind").and_then(Value::as_str) != Some("systemGenerated")
        || receipt.get("isVerified").and_then(Value::as_bool) != Some(true)
        || receipt
            .get("quickAnalysisAutoContextBudgetLimit")
            .and_then(Value::as_u64)
            != Some(1)
        || !matches!(
            (scope.remaining, scope.capability_state.as_str()),
            (1, "CONTEXT_ALLOWED") | (0, "CONTEXT_EXHAUSTED")
        )
        || !matches!(
            scope.authorization_source.as_str(),
            "USER_CLICKED_AI_ANALYSIS" | "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION"
        )
        || !is_canonical_quick_analysis_owner_channel(
            &scope.owner_type,
            Some(scope.channel.as_str()),
        )
    {
        return Err(fail(
            "AI_CONTEXT_REQUEST_SOURCE_STALE",
            "Quick Analysis run authorization provenance is invalid or unsupported",
        ));
    }
    Ok(Some(scope))
}

fn validate_context_request_followup_authorization_set(
    connection: &Connection,
    input: &PrepareAIContextRequestFollowupInput,
    request: &AIContextRequestRecord,
    source_attempt: &AICallAttemptRecord,
    proposed_authorized_ids: &[String],
) -> Result<Vec<String>, String> {
    let approved_body_ids = context_request_body_file_ref_ids(&input.approved_refs)?;
    let source_scope = quick_run_authorization_scope(&source_attempt.context_source_refs)?;
    let followup_scope = quick_run_authorization_scope(&input.context_source_refs)?;
    let typed_receipt = crate::authorized_material::quick_followup_authorization_receipt(
        &input.context_source_refs,
    )
    .map_err(|_| {
        fail(
            "AI_CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED",
            "The typed Quick Context follow-up authorization receipt is malformed",
        )
    })?;
    if source_scope.is_none() && followup_scope.is_none() {
        if typed_receipt.is_some() || approved_body_ids != proposed_authorized_ids {
            return Err(fail(
                "AI_CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED",
                "Every BODY_CONTENT FileRef requires exact explicit per-call authorization, with no extras",
            ));
        }
        return Ok(proposed_authorized_ids.to_vec());
    }
    let source_scope = source_scope.ok_or_else(|| {
        fail(
            "AI_CONTEXT_REQUEST_SOURCE_STALE",
            "The durable source CallAttempt does not carry the Quick run authorization",
        )
    })?;
    let followup_scope = followup_scope.ok_or_else(|| {
        fail(
            "AI_CONTEXT_REQUEST_SOURCE_STALE",
            "The Quick Context follow-up does not carry its derived run authorization",
        )
    })?;
    if source_scope.remaining != 1
        || source_scope.capability_state != "CONTEXT_ALLOWED"
        || followup_scope.authorization_source != "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION"
        || followup_scope.remaining != 0
        || followup_scope.capability_state != "CONTEXT_EXHAUSTED"
        || source_scope.run_id != followup_scope.run_id
        || source_scope.project_id != followup_scope.project_id
        || source_scope.owner_type != followup_scope.owner_type
        || source_scope.owner_id != followup_scope.owner_id
        || source_scope.channel != followup_scope.channel
        || source_scope.source_file_ref_id != followup_scope.source_file_ref_id
        || source_scope.source_directory_file_ref_id != followup_scope.source_directory_file_ref_id
        || source_scope.whitelist_fingerprint != followup_scope.whitelist_fingerprint
        || request.source.get("projectId").and_then(Value::as_str)
            != Some(source_scope.project_id.as_str())
    {
        return Err(fail(
            "AI_CONTEXT_REQUEST_SOURCE_STALE",
            "The Quick Context follow-up scope does not exactly match its durable frozen run",
        ));
    }
    let approved_candidates = input.approved_refs.as_array().ok_or_else(|| {
        fail(
            "AI_CONTEXT_REQUEST_INVALID",
            "Approved Context Request candidates must be an array",
        )
    })?;
    let mut expected_metadata = BTreeSet::new();
    for candidate in approved_candidates {
        let project_id = candidate.get("projectId").and_then(Value::as_str);
        if project_id != Some(source_scope.project_id.as_str()) {
            return Err(fail(
                "AI_CONTEXT_REQUEST_CROSS_PROJECT",
                "A Context Request candidate crosses the frozen Quick Analysis Project",
            ));
        }
        if candidate.get("contributionKind").and_then(Value::as_str) == Some("IDENTITY_METADATA") {
            let ref_kind = candidate
                .get("refKind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let ref_id = candidate
                .get("refId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !matches!(ref_kind, "AI_RESEARCH_OBJECT" | "FILE_REF")
                || ref_id.trim().is_empty()
                || ref_id.trim() != ref_id
            {
                return Err(fail(
                    "AI_CONTEXT_REQUEST_INVALID",
                    "A metadata-only Context Request candidate is malformed",
                ));
            }
            expected_metadata.insert(
                crate::authorized_material::QuickFollowupMetadataReferenceEntry {
                    ref_kind: ref_kind.to_string(),
                    ref_id: ref_id.to_string(),
                    contribution_kind: "IDENTITY_METADATA".to_string(),
                    project_id: source_scope.project_id.clone(),
                    context_request_id: request.id.clone(),
                },
            );
        }
    }
    let source_authorizations = read_authorized_file_refs(connection, &source_attempt.id)?;
    if source_authorizations.is_empty()
        || source_authorizations
            .iter()
            .any(|snapshot| snapshot.availability_status != "available")
        || !source_authorizations
            .iter()
            .any(|snapshot| snapshot.file_ref_id == source_scope.source_file_ref_id)
    {
        return Err(fail(
            "AI_CONTEXT_REQUEST_SOURCE_STALE",
            "The original Quick frozen source authorization is unavailable",
        ));
    }
    let frozen_ids = source_authorizations
        .iter()
        .map(|snapshot| snapshot.file_ref_id.clone())
        .collect::<BTreeSet<_>>();
    let supplemental_ids = approved_body_ids.iter().cloned().collect::<BTreeSet<_>>();
    let expected_ids = frozen_ids
        .union(&supplemental_ids)
        .cloned()
        .collect::<Vec<_>>();
    if expected_ids != proposed_authorized_ids {
        return Err(fail(
            "AI_CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED",
            "The follow-up BODY authorization must exactly equal frozen Quick source UNION approved Context Request BODY entries",
        ));
    }
    let typed_receipt = typed_receipt.ok_or_else(|| {
        fail(
            "AI_CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED",
            "The Quick Context follow-up is missing its typed BODY authorization receipt",
        )
    })?;
    if typed_receipt.run_id != source_scope.run_id
        || typed_receipt.context_request_id != request.id
        || typed_receipt.project_id != source_scope.project_id
        || typed_receipt.owner_type != source_scope.owner_type
        || typed_receipt.owner_id != source_scope.owner_id
        || typed_receipt.channel != source_scope.channel
        || typed_receipt.body_entries.len() != expected_ids.len()
        || typed_receipt
            .metadata_entries
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
            != expected_metadata
        || typed_receipt.metadata_entries.len() != expected_metadata.len()
    {
        return Err(fail(
            "AI_CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED",
            "The typed Quick follow-up authorization receipt does not match the canonical BODY/metadata ledgers",
        ));
    }
    let mut canonical_body_keys = BTreeSet::new();
    for (index, entry) in typed_receipt.body_entries.iter().enumerate() {
        let expected_id = expected_ids.get(index).map(String::as_str);
        let expected_origins = match (
            frozen_ids.contains(&entry.file_ref_id),
            supplemental_ids.contains(&entry.file_ref_id),
        ) {
            (true, true) => vec![
                "RUN_SCOPED_FROZEN_SOURCE".to_string(),
                "CONTEXT_REQUEST_APPROVAL".to_string(),
            ],
            (true, false) => vec!["RUN_SCOPED_FROZEN_SOURCE".to_string()],
            (false, true) => vec!["CONTEXT_REQUEST_APPROVAL".to_string()],
            (false, false) => Vec::new(),
        };
        let expected_context_request_ids = if supplemental_ids.contains(&entry.file_ref_id) {
            vec![request.id.clone()]
        } else {
            Vec::new()
        };
        let current: Option<(String, String, String, String, String, Option<String>)> = connection
            .query_row(
                "SELECT owner_type,owner_id,manuscript_channel,path,resource_kind,deleted_at
                 FROM file_refs WHERE id=?1",
                [&entry.file_ref_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
        let Some((owner_type, owner_id, channel, path, resource_kind, deleted_at)) = current else {
            return Err(fail(
                "AI_CONTEXT_REQUEST_SOURCE_STALE",
                "A Quick follow-up FileRef is no longer canonical",
            ));
        };
        let current_freshness = crate::authorized_material::inspect_material_freshness_receipt(
            std::path::Path::new(&path),
            &entry.file_ref_id,
        );
        if expected_id != Some(entry.file_ref_id.as_str())
            || entry.material_use != "BODY_CONTENT"
            || entry.authorization_origins != expected_origins
            || entry.project_id != source_scope.project_id
            || entry.owner_type != source_scope.owner_type
            || entry.owner_id != source_scope.owner_id
            || entry.channel != source_scope.channel
            || entry.context_request_ids != expected_context_request_ids
            || entry.source_freshness_identity.file_ref_id != entry.file_ref_id
            || owner_type != source_scope.owner_type
            || owner_id != source_scope.owner_id
            || channel != source_scope.channel
            || resource_kind != "file"
            || deleted_at.is_some()
            || current_freshness.as_ref() != Some(&entry.source_freshness_identity)
            || !canonical_body_keys.insert((
                entry.file_ref_id.as_str(),
                entry.project_id.as_str(),
                entry.owner_type.as_str(),
                entry.owner_id.as_str(),
                entry.channel.as_str(),
                entry.source_freshness_identity.source_token.as_str(),
                entry.material_use.as_str(),
            ))
        {
            return Err(fail(
                "AI_CONTEXT_REQUEST_SOURCE_STALE",
                "The typed Quick follow-up BODY scope or freshness identity changed before durable prepare",
            ));
        }
    }
    Ok(expected_ids)
}


fn validate_context_request_followup_input(
    input: &PrepareAIContextRequestFollowupInput,
) -> Result<Vec<String>, String> {
    for (value, field, max) in [
        (&input.conversation_id, "conversationId", 200),
        (&input.context_request_id, "contextRequestId", 200),
        (&input.action_message_id, "actionMessageId", 200),
        (&input.attempt_id, "attemptId", 200),
        (&input.request_id, "requestId", 200),
        (&input.purpose, "purpose", 40),
        (&input.provider, "provider", 120),
        (&input.model, "model", 200),
        (&input.context_package_id, "contextPackageId", 200),
        (&input.context_package_version, "contextPackageVersion", 120),
        (&input.prompt_package_id, "promptPackageId", 200),
        (&input.prompt_created_at, "promptCreatedAt", 80),
        (&input.started_at, "startedAt", 80),
    ] {
        require_text(value, field, max)?;
    }
    if input.attempt_id != input.request_id {
        return Err(fail(
            "AI_CONTEXT_REQUEST_ATTEMPT_IDENTITY_CONFLICT",
            "Context Request follow-up requires one canonical CallAttempt/request identity",
        ));
    }
    if !matches!(input.purpose.as_str(), "chat_response" | "parse_draft") {
        return Err(fail(
            "AI_CONTEXT_REQUEST_FOLLOWUP_INVALID",
            "Context Request follow-up purpose is outside the covered consumer set",
        ));
    }
    if !input.context_source_refs.is_array() || !input.warnings.is_array() {
        return Err(fail(
            "AI_CONTEXT_REQUEST_FOLLOWUP_INVALID",
            "Context Request follow-up provenance is invalid",
        ));
    }
    json_text(&input.context_source_refs, "contextSourceRefs")?;
    validate_a3_constraint_source_refs(&input.context_source_refs, &input.purpose)?;
    json_text(&input.warnings, "warnings")?;
    optional_json_text(&input.budget_summary, "budgetSummary")?;
    json_text(
        &input.expected_reviewed_candidates,
        "expectedReviewedCandidates",
    )?;
    json_text(&input.approved_refs, "approvedRefs")?;
    if input.expected_reviewed_candidates != input.approved_refs {
        return Err(fail(
            "AI_CONTEXT_REQUEST_REVIEW_MISMATCH",
            "The approved Context Request refs must exactly match the reviewed set",
        ));
    }
    normalized_authorized_file_ref_ids(&input.authorized_file_ref_ids)
}

pub(crate) fn prepare_ai_context_request_followup_in_connection(
    connection: &mut Connection,
    input: &PrepareAIContextRequestFollowupInput,
) -> Result<PreparedAICallAttempt, String> {
    let proposed_authorized_ids = validate_context_request_followup_input(input)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            fail(
                "AI_CONTEXT_REQUEST_PREPARE_FAILED",
                error.to_string(),
            )
        })?;
    read_conversation_record(&transaction, &input.conversation_id)?;
    let request = context_request_for_conversation(
        &transaction,
        &input.conversation_id,
        &input.context_request_id,
    )?;
    if request.state != "PENDING" {
        return Err(fail(
            "AI_CONTEXT_REQUEST_TERMINAL_CONFLICT",
            "This Context Request already has a terminal decision",
        ));
    }
    if request.reviewed_candidates != input.expected_reviewed_candidates {
        return Err(fail(
            "AI_CONTEXT_REQUEST_REVIEW_MISMATCH",
            "The canonical reviewed Context Request set has changed",
        ));
    }
    let messages = read_messages(&transaction, &input.conversation_id)?;
    let attempts = read_call_attempts_without_authorizations(&transaction, &input.conversation_id)?;
    let source_attempt = attempts
        .iter()
        .find(|attempt| attempt.id == request.source_call_attempt_id)
        .ok_or_else(|| fail("AI_CONTEXT_REQUEST_STALE", "Context Request source attempt is missing"))?;
    let source_is_current = if input.purpose == "chat_response" {
        let projection = project_effective_conversation(&input.conversation_id, &messages, &attempts);
        source_attempt.purpose == "chat_response"
            && projection.effective_assistant_message_id.as_deref()
                == Some(request.source_message_id.as_str())
            && projection.effective_source_attempt_id.as_deref()
                == Some(request.source_call_attempt_id.as_str())
            && projection.latest_turn_id.as_deref()
                == source_attempt.trigger_message_id.as_deref()
    } else {
        source_attempt.purpose == "parse_draft"
            && source_attempt.status == "succeeded"
            && source_attempt.result_message_id.as_deref()
                == Some(request.source_message_id.as_str())
    };
    if !source_is_current {
        return Err(fail(
            "AI_CONTEXT_REQUEST_STALE",
            "The Context Request source is no longer the effective latest Conversation result",
        ));
    }
    let authorized_ids = validate_context_request_followup_authorization_set(
        &transaction,
        input,
        &request,
        source_attempt,
        &proposed_authorized_ids,
    )?;
    if active_ai_attempt_exists_for_conversation(&transaction, &input.conversation_id)? {
        return Err(fail(
            "AI_CONTEXT_REQUEST_ACTIVE_CONFLICT",
            "Another canonical AI invocation is already active",
        ));
    }
    if read_call_attempt_by_id_without_authorizations(&transaction, &input.attempt_id)?.is_some()
        || read_call_attempt_by_request_id(&transaction, &input.request_id)?.is_some()
    {
        return Err(fail(
            "AI_CONTEXT_REQUEST_ATTEMPT_IDENTITY_CONFLICT",
            "The proposed Context Request follow-up identity is already in use",
        ));
    }
    let authorized_file_refs = resolve_authorized_file_refs(&transaction, &authorized_ids)?;
    insert_context_request_action_message(
        &transaction,
        &input.conversation_id,
        &input.action_message_id,
        "APPROVE_CONTEXT_REQUEST",
        &input.context_request_id,
        &input.started_at,
    )?;
    let attempt_sequence = next_sequence(&transaction, "ai_call_attempts", &input.conversation_id)?;
    let source_refs_json = json_text(&input.context_source_refs, "contextSourceRefs")?;
    let warnings_json = json_text(&input.warnings, "warnings")?;
    let budget_json = optional_json_text(&input.budget_summary, "budgetSummary")?;
    transaction
        .execute(
            "INSERT INTO ai_call_attempts(
               id,request_id,conversation_id,sequence,purpose,trigger_message_id,
               trigger_call_attempt_id,result_message_id,provider,model,status,
               context_package_id,context_package_version,context_source_refs_json,warnings_json,
               budget_summary_json,prompt_package_id,prompt_created_at,started_at
             ) VALUES (
               ?1,?2,?3,?4,?5,?6,?7,NULL,?8,?9,'started',
               ?10,?11,?12,?13,?14,?15,?16,?17
             )",
            params![
                input.attempt_id,
                input.request_id,
                input.conversation_id,
                attempt_sequence,
                input.purpose,
                input.action_message_id,
                request.source_call_attempt_id,
                input.provider,
                input.model,
                input.context_package_id,
                input.context_package_version,
                source_refs_json,
                warnings_json,
                budget_json,
                input.prompt_package_id,
                input.prompt_created_at,
                input.started_at,
            ],
        )
        .map_err(|error| fail("AI_CONTEXT_REQUEST_PREPARE_FAILED", error.to_string()))?;
    insert_authorized_file_refs(
        &transaction,
        &input.attempt_id,
        &input.started_at,
        &authorized_file_refs,
    )?;
    let approved_refs_json = json_text(&input.approved_refs, "approvedRefs")?;
    let updated = transaction
        .execute(
            "UPDATE ai_context_requests SET
               state='APPROVED',decision_action_message_id=?1,decision_type='APPROVE',
               decision_at=?2,decision_reason=NULL,approved_refs_json=?3,
               followup_call_attempt_id=?4
             WHERE id=?5 AND conversation_id=?6 AND state='PENDING'",
            params![
                input.action_message_id,
                input.started_at,
                approved_refs_json,
                input.attempt_id,
                input.context_request_id,
                input.conversation_id,
            ],
        )
        .map_err(|error| fail("AI_CONTEXT_REQUEST_PREPARE_FAILED", error.to_string()))?;
    if updated != 1 {
        return Err(fail(
            "AI_CONTEXT_REQUEST_TERMINAL_CONFLICT",
            "Context Request decision changed before approval could commit",
        ));
    }
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.started_at, input.conversation_id],
        )
        .map_err(|error| fail("AI_CONTEXT_REQUEST_PREPARE_FAILED", error.to_string()))?;
    transaction
        .commit()
        .map_err(|error| fail("AI_CONTEXT_REQUEST_PREPARE_FAILED", error.to_string()))?;
    Ok(PreparedAICallAttempt {
        provider_invocation_authorized: true,
        readback: read_ai_conversation_in_connection(connection, &input.conversation_id)?,
    })
}

pub(crate) fn reject_ai_context_request_in_connection(
    connection: &mut Connection,
    input: &DecideAIContextRequestInput,
) -> Result<AIConversationReadback, String> {
    for (value, field) in [
        (&input.conversation_id, "conversationId"),
        (&input.context_request_id, "contextRequestId"),
        (&input.action_message_id, "actionMessageId"),
        (&input.decided_at, "decidedAt"),
    ] {
        require_text(value, field, 200)?;
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| fail("AI_CONTEXT_REQUEST_DECISION_FAILED", error.to_string()))?;
    let request = context_request_for_conversation(
        &transaction,
        &input.conversation_id,
        &input.context_request_id,
    )?;
    if request.state != "PENDING" {
        return Err(fail(
            "AI_CONTEXT_REQUEST_TERMINAL_CONFLICT",
            "This Context Request already has a terminal decision",
        ));
    }
    insert_context_request_action_message(
        &transaction,
        &input.conversation_id,
        &input.action_message_id,
        "REJECT_CONTEXT_REQUEST",
        &input.context_request_id,
        &input.decided_at,
    )?;
    let updated = transaction
        .execute(
            "UPDATE ai_context_requests SET
               state='REJECTED',decision_action_message_id=?1,decision_type='REJECT',
               decision_at=?2,decision_reason=NULL
             WHERE id=?3 AND conversation_id=?4 AND state='PENDING'",
            params![
                input.action_message_id,
                input.decided_at,
                input.context_request_id,
                input.conversation_id,
            ],
        )
        .map_err(|error| fail("AI_CONTEXT_REQUEST_DECISION_FAILED", error.to_string()))?;
    if updated != 1 {
        return Err(fail(
            "AI_CONTEXT_REQUEST_TERMINAL_CONFLICT",
            "Context Request decision changed before rejection could commit",
        ));
    }
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.decided_at, input.conversation_id],
        )
        .map_err(|error| fail("AI_CONTEXT_REQUEST_DECISION_FAILED", error.to_string()))?;
    transaction
        .commit()
        .map_err(|error| fail("AI_CONTEXT_REQUEST_DECISION_FAILED", error.to_string()))?;
    read_ai_conversation_in_connection(connection, &input.conversation_id)
}

pub(crate) fn mark_ai_context_request_stale_in_connection(
    connection: &mut Connection,
    input: &MarkAIContextRequestStaleInput,
) -> Result<AIConversationReadback, String> {
    require_text(&input.conversation_id, "conversationId", 200)?;
    require_text(&input.context_request_id, "contextRequestId", 200)?;
    require_text(&input.reason, "reason", 600)?;
    require_text(&input.decided_at, "decidedAt", 80)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| fail("AI_CONTEXT_REQUEST_DECISION_FAILED", error.to_string()))?;
    context_request_for_conversation(
        &transaction,
        &input.conversation_id,
        &input.context_request_id,
    )?;
    let updated = transaction
        .execute(
            "UPDATE ai_context_requests SET
               state='STALE_OR_INVALID',decision_type='STALE',decision_at=?1,decision_reason=?2
             WHERE id=?3 AND conversation_id=?4 AND state='PENDING'",
            params![
                input.decided_at,
                input.reason,
                input.context_request_id,
                input.conversation_id,
            ],
        )
        .map_err(|error| fail("AI_CONTEXT_REQUEST_DECISION_FAILED", error.to_string()))?;
    if updated != 1 {
        return Err(fail(
            "AI_CONTEXT_REQUEST_TERMINAL_CONFLICT",
            "Context Request decision changed before stale marking could commit",
        ));
    }
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.decided_at, input.conversation_id],
        )
        .map_err(|error| fail("AI_CONTEXT_REQUEST_DECISION_FAILED", error.to_string()))?;
    transaction
        .commit()
        .map_err(|error| fail("AI_CONTEXT_REQUEST_DECISION_FAILED", error.to_string()))?;
    read_ai_conversation_in_connection(connection, &input.conversation_id)
}

fn standard_result_for_conversation(
    connection: &Connection,
    conversation_id: &str,
    result_id: &str,
) -> Result<AIStandardResultRecord, String> {
    read_standard_results(connection, conversation_id)?
        .into_iter()
        .find(|result| result.id == result_id)
        .ok_or_else(|| {
            fail(
                "AI_STANDARD_RESULT_NOT_FOUND",
                "The Standard Result does not belong to this Conversation",
            )
        })
}

pub(crate) fn update_ai_standard_result_draft_in_connection(
    connection: &mut Connection,
    input: &UpdateAIStandardResultDraftInput,
) -> Result<AIConversationReadback, String> {
    for (value, field, max) in [
        (&input.conversation_id, "conversationId", 200),
        (&input.result_id, "resultId", 200),
        (
            &input.expected_visible_payload_fingerprint,
            "expectedVisiblePayloadFingerprint",
            200,
        ),
        (
            &input.visible_payload_fingerprint,
            "visiblePayloadFingerprint",
            200,
        ),
        (&input.updated_at, "updatedAt", 80),
    ] {
        require_text(value, field, max)?;
    }
    if !input.visible_payload.is_object() || !input.validation_issues.is_array() {
        return Err(fail(
            "AI_STANDARD_RESULT_INVALID",
            "Visible payload must be an object and validation issues must be an array",
        ));
    }
    let visible_json = json_text(&input.visible_payload, "visiblePayload")?;
    let issues_json = json_text(&input.validation_issues, "validationIssues")?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    let current = standard_result_for_conversation(
        &transaction,
        &input.conversation_id,
        &input.result_id,
    )?;
    if current.disposition != "PENDING" || current.authorization_id.is_some() {
        return Err(fail(
            "AI_STANDARD_RESULT_TERMINAL_CONFLICT",
            "Only an unclaimed pending Standard Result can be edited",
        ));
    }
    if current.visible_payload_fingerprint != input.expected_visible_payload_fingerprint {
        if current.visible_payload == input.visible_payload
            && current.visible_payload_fingerprint == input.visible_payload_fingerprint
            && current.validation_issues == input.validation_issues
            && current.updated_at == input.updated_at
        {
            transaction
                .commit()
                .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
            return read_ai_conversation_in_connection(connection, &input.conversation_id);
        }
        return Err(fail(
            "AI_STANDARD_RESULT_STALE_EDIT",
            "The Standard Result visible payload changed before this edit",
        ));
    }
    let updated = transaction
        .execute(
            "UPDATE ai_standard_results SET visible_payload_json=?1,
               visible_payload_fingerprint=?2,validation_issues_json=?3,updated_at=?4
             WHERE id=?5 AND conversation_id=?6 AND disposition='PENDING' AND
               authorization_id IS NULL AND visible_payload_fingerprint=?7",
            params![
                visible_json,
                input.visible_payload_fingerprint,
                issues_json,
                input.updated_at,
                input.result_id,
                input.conversation_id,
                input.expected_visible_payload_fingerprint,
            ],
        )
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    if updated != 1 {
        return Err(fail(
            "AI_STANDARD_RESULT_STALE_EDIT",
            "The Standard Result changed before this edit could commit",
        ));
    }
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.updated_at, input.conversation_id],
        )
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    transaction
        .commit()
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    read_ai_conversation_in_connection(connection, &input.conversation_id)
}

pub(crate) fn dismiss_ai_standard_result_in_connection(
    connection: &mut Connection,
    input: &DecideAIStandardResultInput,
) -> Result<AIConversationReadback, String> {
    for (value, field, max) in [
        (&input.conversation_id, "conversationId", 200),
        (&input.result_id, "resultId", 200),
        (
            &input.expected_visible_payload_fingerprint,
            "expectedVisiblePayloadFingerprint",
            200,
        ),
        (&input.decided_at, "decidedAt", 80),
    ] {
        require_text(value, field, max)?;
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    let current = standard_result_for_conversation(
        &transaction,
        &input.conversation_id,
        &input.result_id,
    )?;
    if current.disposition == "DISMISSED" && current.decided_at.as_deref() == Some(&input.decided_at)
    {
        transaction
            .commit()
            .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
        return read_ai_conversation_in_connection(connection, &input.conversation_id);
    }
    if current.disposition != "PENDING"
        || current.authorization_id.is_some()
        || current.visible_payload_fingerprint != input.expected_visible_payload_fingerprint
    {
        return Err(fail(
            "AI_STANDARD_RESULT_TERMINAL_CONFLICT",
            "Only the exact unclaimed pending Standard Result can be dismissed",
        ));
    }
    let updated = transaction
        .execute(
            "UPDATE ai_standard_results SET disposition='DISMISSED',decided_at=?1,updated_at=?1
             WHERE id=?2 AND conversation_id=?3 AND disposition='PENDING' AND
               authorization_id IS NULL AND visible_payload_fingerprint=?4",
            params![
                input.decided_at,
                input.result_id,
                input.conversation_id,
                input.expected_visible_payload_fingerprint,
            ],
        )
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    if updated != 1 {
        return Err(fail(
            "AI_STANDARD_RESULT_TERMINAL_CONFLICT",
            "The Standard Result changed before dismissal could commit",
        ));
    }
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.decided_at, input.conversation_id],
        )
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    transaction
        .commit()
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    read_ai_conversation_in_connection(connection, &input.conversation_id)
}

fn is_canonical_quick_analysis_owner_channel(owner: &str, channel: Option<&str>) -> bool {
    matches!(
        (owner, channel),
        ("experiment", Some("primary"))
            | ("experimentRun", Some("primary"))
            | ("literature", Some("literature_outline" | "dedicated_notes"))
            | ("review", Some("primary"))
            | ("resultItem", Some("primary"))
            | ("finding", Some("primary"))
            | ("outputCandidate", Some("primary"))
            | ("outputGap", Some("primary"))
            | ("researchOutput", Some("primary"))
    )
}

pub(crate) fn begin_ai_standard_result_confirmation_in_connection(
    connection: &mut Connection,
    input: &BeginAIStandardResultConfirmationInput,
) -> Result<AIConversationReadback, String> {
    for (value, field, max) in [
        (&input.conversation_id, "conversationId", 200),
        (&input.result_id, "resultId", 200),
        (&input.parse_call_attempt_id, "parseCallAttemptId", 200),
        (
            &input.expected_visible_payload_fingerprint,
            "expectedVisiblePayloadFingerprint",
            200,
        ),
        (&input.authorization_id, "authorizationId", 200),
        (
            &input.confirmed_payload_fingerprint,
            "confirmedPayloadFingerprint",
            200,
        ),
        (&input.started_at, "startedAt", 80),
    ] {
        require_text(value, field, max)?;
    }
    if !input.confirmed_payload.is_object() {
        return Err(fail(
            "AI_STANDARD_RESULT_INVALID",
            "The confirmed Standard Result payload must be an object",
        ));
    }
    let confirmed_json = json_text(&input.confirmed_payload, "confirmedPayload")?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    let current = standard_result_for_conversation(
        &transaction,
        &input.conversation_id,
        &input.result_id,
    )?;
    let current_target_module = required_json_text_field(&current.target, "module")?;
    let current_target_entity_type = required_json_text_field(&current.target, "entityType")?;
    let executable_capability = matches!(
        (
            current_target_module,
            current_target_entity_type,
            current.action.as_str(),
        ),
        ("route", "routeNode", "CREATE" | "UPDATE")
            | ("task", "task", "CREATE" | "UPDATE")
            | ("finding", "finding", "CREATE")
            | ("review", "review", "CREATE" | "UPDATE" | "NEW_MANUSCRIPT")
            | ("experiment", "experiment", "CREATE" | "UPDATE")
            | ("experimentRun", "experimentRun", "CREATE" | "UPDATE")
            | ("literature", "literature", "CREATE" | "UPDATE")
    ) || (
        current_target_module == current_target_entity_type
            && matches!(
                current_target_module,
                "resultItem" | "finding" | "outputCandidate" | "outputGap" | "researchOutput"
            )
            && matches!(current.action.as_str(), "CREATE" | "UPDATE")
    ) || (
        current_target_module == "experiment"
            && current_target_entity_type == "experiment"
            && current.action == "NEW_MANUSCRIPT"
            && current.target.get("manuscriptChannel").and_then(Value::as_str)
                == Some("primary")
    ) || (
        current_target_module == "experimentRun"
            && current_target_entity_type == "experimentRun"
            && current.action == "NEW_MANUSCRIPT"
            && current.target.get("manuscriptChannel").and_then(Value::as_str)
                == Some("primary")
    ) || (
        current_target_module == "literature"
            && current_target_entity_type == "literature"
            && current.action == "NEW_MANUSCRIPT"
            && matches!(
                current.target.get("manuscriptChannel").and_then(Value::as_str),
                Some("literature_outline") | Some("dedicated_notes")
            )
    ) || (
        current.action == "NEW_MANUSCRIPT"
            && current_target_entity_type == current_target_module
            && is_canonical_quick_analysis_owner_channel(
                current_target_module,
                current.target.get("manuscriptChannel").and_then(Value::as_str),
            )
    );
    if current.authorization_id.as_deref() == Some(&input.authorization_id)
        && current.confirmation_started_at.as_deref() == Some(&input.started_at)
        && current.confirmed_payload.as_ref() == Some(&input.confirmed_payload)
        && current.confirmed_payload_fingerprint.as_deref()
            == Some(&input.confirmed_payload_fingerprint)
    {
        transaction
            .commit()
            .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
        return read_ai_conversation_in_connection(connection, &input.conversation_id);
    }
    if current.disposition != "PENDING"
        || current.authorization_id.is_some()
        || current.parse_call_attempt_id != input.parse_call_attempt_id
        || current.visible_payload_fingerprint != input.expected_visible_payload_fingerprint
        || !executable_capability
    {
        return Err(fail(
            "AI_STANDARD_RESULT_CONFIRMATION_CONFLICT",
            "The exact executable pending Standard Result could not be claimed",
        ));
    }
    let updated = transaction
        .execute(
            "UPDATE ai_standard_results SET confirmation_started_at=?1,authorization_id=?2,
               confirmed_payload_json=?3,confirmed_payload_fingerprint=?4,updated_at=?1
             WHERE id=?5 AND conversation_id=?6 AND parse_call_attempt_id=?7 AND
               disposition='PENDING' AND authorization_id IS NULL AND
               visible_payload_fingerprint=?8 AND action IN ('CREATE','UPDATE','NEW_MANUSCRIPT')",
            params![
                input.started_at,
                input.authorization_id,
                confirmed_json,
                input.confirmed_payload_fingerprint,
                input.result_id,
                input.conversation_id,
                input.parse_call_attempt_id,
                input.expected_visible_payload_fingerprint,
            ],
        )
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    if updated != 1 {
        return Err(fail(
            "AI_STANDARD_RESULT_CONFIRMATION_CONFLICT",
            "The Standard Result changed before confirmation could begin",
        ));
    }
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.started_at, input.conversation_id],
        )
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    transaction
        .commit()
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    read_ai_conversation_in_connection(connection, &input.conversation_id)
}

fn confirmed_same_batch_experiment_parent_entity_id(
    connection: &Connection,
    current: &AIStandardResultRecord,
) -> Result<Option<String>, String> {
    let Some(metadata) = current
        .original_payload
        .get("_labpod")
        .and_then(Value::as_object)
    else {
        return Ok(None);
    };
    if metadata.get("protocol").and_then(Value::as_str)
        != Some("labpod-standard-result-proposal-v1")
        || metadata.get("originalOrdinal").and_then(Value::as_i64) != Some(current.ordinal)
    {
        return Ok(None);
    }
    let Some(parent_proposal_ref) = metadata
        .get("parentProposalRef")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 200)
    else {
        return Ok(None);
    };
    let target_project_id = current.target.get("projectId").and_then(Value::as_str);
    let readback = read_ai_conversation_in_connection(connection, &current.conversation_id)?;
    let matches = readback
        .standard_results
        .iter()
        .filter(|candidate| {
            let candidate_metadata = candidate
                .original_payload
                .get("_labpod")
                .and_then(Value::as_object);
            candidate.id != current.id
                && candidate.batch_id == current.batch_id
                && candidate.parse_call_attempt_id == current.parse_call_attempt_id
                && candidate.ordinal < current.ordinal
                && candidate.category == "DATA_OPERATION"
                && candidate.action == "CREATE"
                && candidate.disposition == "CONFIRMED"
                && candidate.target.get("module").and_then(Value::as_str) == Some("experiment")
                && candidate.target.get("entityType").and_then(Value::as_str)
                    == Some("experiment")
                && candidate.target.get("projectId").and_then(Value::as_str) == target_project_id
                && candidate_metadata
                    .and_then(|value| value.get("protocol"))
                    .and_then(Value::as_str)
                    == Some("labpod-standard-result-proposal-v1")
                && candidate_metadata
                    .and_then(|value| value.get("originalOrdinal"))
                    .and_then(Value::as_i64)
                    == Some(candidate.ordinal)
                && candidate_metadata
                    .and_then(|value| value.get("proposalRef"))
                    .and_then(Value::as_str)
                    == Some(parent_proposal_ref)
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Ok(None);
    }
    let parent = matches[0];
    let Some(receipt) = parent.effect_receipt.as_ref() else {
        return Ok(None);
    };
    let entity_id = receipt.get("entityId").and_then(Value::as_str);
    let canonical = receipt.get("canonicalReadback").and_then(Value::as_object);
    let exact_receipt = receipt.get("module").and_then(Value::as_str) == Some("experiment")
        && receipt.get("entityType").and_then(Value::as_str) == Some("experiment")
        && receipt.get("operation").and_then(Value::as_str) == Some("CREATE")
        && receipt.get("service").and_then(Value::as_str)
            == Some("experimentService.createExperiment")
        && entity_id.is_some_and(|value| !value.trim().is_empty() && value.len() <= 200)
        && canonical.and_then(|value| value.get("id")).and_then(Value::as_str) == entity_id
        && canonical
            .and_then(|value| value.get("projectId"))
            .and_then(Value::as_str)
            == target_project_id
        && canonical
            .and_then(|value| value.get("operationId"))
            .and_then(Value::as_str)
            == Some(parent.id.as_str());
    Ok(exact_receipt.then(|| entity_id.unwrap().to_owned()))
}

fn lp14_a1_c4_canonical_fingerprint(value: &Value) -> Option<String> {
    let canonical = serde_json::to_string(value).ok()?;
    let mut hash = 0x811c9dc5_u32;
    for character in canonical.chars() {
        hash ^= character as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    Some(format!("lp13-a6-{hash:08x}"))
}

fn lp14_a1_c4_bounded_fingerprint(value: Option<&str>) -> bool {
    value
        .and_then(|candidate| candidate.strip_prefix("lp13-a6-"))
        .is_some_and(|suffix| {
            suffix.len() == 8 && suffix.chars().all(|character| character.is_ascii_hexdigit())
        })
}

fn lp14_a1_c4_parent_manuscript_receipt_matches(
    current: &AIStandardResultRecord,
    authorization_id: &str,
    owner_id: &str,
    channel: &str,
    body: &str,
    receipt: &Value,
) -> bool {
    let target_module = current.target.get("module").and_then(Value::as_str);
    let target_project_id = current.target.get("projectId").and_then(Value::as_str);
    let receipt_object = match receipt.as_object() {
        Some(value) if value.len() == 6 => value,
        _ => return false,
    };
    let canonical = match receipt_object
        .get("canonicalReadback")
        .and_then(Value::as_object)
    {
        Some(value) => value,
        None => return false,
    };
    let child_result_id = format!("{}:manuscript:{channel}", current.id);
    let receipt_entity_id = receipt_object.get("entityId").and_then(Value::as_str);
    let expected_payload_fingerprint = lp14_a1_c4_canonical_fingerprint(
        &serde_json::json!({"body": body}),
    );
    let expected_body_fingerprint =
        lp14_a1_c4_canonical_fingerprint(&Value::String(body.to_owned()));
    let expected_service = match target_module {
        Some("review") => "reviewCandidateService.saveCandidate",
        Some("experiment") => "experimentManuscriptSaveAsAdapter.saveAs",
        Some("experimentRun") => "experimentRunManuscriptSaveAsAdapter.saveAs",
        Some("literature") => "literatureManuscriptSaveAsAdapter.saveAs",
        _ => return false,
    };
    let allowed_channel = match target_module {
        Some("literature") => matches!(channel, "literature_outline" | "dedicated_notes"),
        Some("review" | "experiment" | "experimentRun") => channel == "primary",
        _ => false,
    };
    if !allowed_channel
        || receipt_object.get("module").and_then(Value::as_str) != target_module
        || receipt_object.get("entityType").and_then(Value::as_str) != Some("fileRef")
        || receipt_entity_id
            .is_none_or(|value| value.trim().is_empty() || value.len() > 200)
        || receipt_object.get("operation").and_then(Value::as_str)
            != Some("NEW_MANUSCRIPT")
        || receipt_object.get("service").and_then(Value::as_str) != Some(expected_service)
        || canonical.get("projectId").and_then(Value::as_str) != target_project_id
        || canonical.get("manuscriptChannel").and_then(Value::as_str) != Some(channel)
        || canonical.get("fileRefId").and_then(Value::as_str) != receipt_entity_id
        || canonical.get("resourceKind").and_then(Value::as_str) != Some("file")
        || canonical.get("fileRole").and_then(Value::as_str) != Some("manuscript")
        || canonical.get("physicalEncoding").and_then(Value::as_str) != Some("utf-8")
        || canonical.get("documentLineEnding").and_then(Value::as_str) != Some("LF")
        || canonical
            .get("confirmedBodyFingerprint")
            .and_then(Value::as_str)
            != expected_body_fingerprint.as_deref()
        || canonical
            .get("physicalBodyFingerprint")
            .and_then(Value::as_str)
            != expected_body_fingerprint.as_deref()
        || canonical.get("currentChanged").and_then(Value::as_bool) != Some(false)
        || canonical.get("formalSwitchInvoked").and_then(Value::as_bool) != Some(false)
    {
        return false;
    }

    match target_module {
        Some("review") => {
            canonical.get("reviewId").and_then(Value::as_str) == Some(owner_id)
                && canonical.get("operationId").and_then(Value::as_str)
                    == Some(child_result_id.as_str())
                && canonical.get("candidateRequestId").and_then(Value::as_str)
                    == Some(child_result_id.as_str())
                && canonical.get("bindingBefore") == canonical.get("bindingAfter")
        }
        Some("experiment") => {
            let expected_operation_id =
                format!("a11-exp-man:{child_result_id}:{authorization_id}");
            let operation_generation = canonical
                .get("operationGeneration")
                .and_then(Value::as_u64)
                .filter(|generation| *generation > 0);
            let expected_candidate_request_id = operation_generation
                .map(|generation| format!("{expected_operation_id}:{generation}"));
            canonical.get("experimentId").and_then(Value::as_str) == Some(owner_id)
                && canonical.get("resultId").and_then(Value::as_str)
                    == Some(child_result_id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(authorization_id)
                && canonical.get("operationId").and_then(Value::as_str)
                    == Some(expected_operation_id.as_str())
                && canonical.get("candidateRequestId").and_then(Value::as_str)
                    == expected_candidate_request_id.as_deref()
                && canonical
                    .get("candidateOccurredAt")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty() && value.len() <= 80)
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == expected_payload_fingerprint.as_deref()
                && canonical.get("sourceFileRefId").and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty() && Some(value) != receipt_entity_id)
                && canonical.get("sourcePathIdentityKey").and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                && canonical.get("candidatePathIdentityKey").and_then(Value::as_str)
                    .is_some_and(|value| {
                        !value.trim().is_empty()
                            && Some(value)
                                != canonical
                                    .get("sourcePathIdentityKey")
                                    .and_then(Value::as_str)
                    })
                && canonical.get("sourceDirectoryPathIdentityKey")
                    == canonical.get("candidateDirectoryPathIdentityKey")
                && canonical.get("targetLocationMode").and_then(Value::as_str)
                    == Some("managed")
                && canonical.get("operationStage").and_then(Value::as_str)
                    == Some("completed")
                && canonical.get("d1CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("d2CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("bindingBefore") == canonical.get("bindingAfter")
                && canonical.get("bindingPreserved").and_then(Value::as_bool) == Some(true)
                && canonical.get("defaultChanged").and_then(Value::as_bool) == Some(false)
                && canonical.get("readbackState").and_then(Value::as_str)
                    == Some("AUTHORITATIVE_FILE_REF_LIST_PHYSICAL_BODY_BINDING_PRESERVED")
        }
        Some("experimentRun") => {
            let expected_operation_id =
                format!("a14-run-man:{child_result_id}:{authorization_id}");
            let operation_generation = canonical
                .get("operationGeneration")
                .and_then(Value::as_u64)
                .filter(|generation| *generation > 0);
            let expected_candidate_request_id = operation_generation
                .map(|generation| format!("{expected_operation_id}:{generation}"));
            let binding = canonical.get("bindingReadback").and_then(Value::as_object);
            canonical.get("runId").and_then(Value::as_str) == Some(owner_id)
                && canonical.get("parentExperimentId") == current.target.get("parentExperimentId")
                && canonical.get("resultId").and_then(Value::as_str)
                    == Some(child_result_id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(authorization_id)
                && lp14_a1_c4_bounded_fingerprint(
                    canonical.get("authorizationFingerprint").and_then(Value::as_str),
                )
                && canonical.get("operationId").and_then(Value::as_str)
                    == Some(expected_operation_id.as_str())
                && canonical.get("candidateRequestId").and_then(Value::as_str)
                    == expected_candidate_request_id.as_deref()
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == expected_payload_fingerprint.as_deref()
                && canonical.get("latestVisibleSourceBodyFingerprint")
                    == canonical.get("confirmedBodyFingerprint")
                && canonical.get("artifactAssociation").and_then(Value::as_str)
                    == Some("INDEPENDENT_MANAGED_MANUSCRIPT")
                && lp14_a1_c4_bounded_fingerprint(
                    canonical.get("targetIdentityDigest").and_then(Value::as_str),
                )
                && canonical.get("targetLocationMode").and_then(Value::as_str)
                    == Some("managed")
                && canonical.get("operationStage").and_then(Value::as_str)
                    == Some("completed")
                && canonical.get("d1CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("d2CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("preservationOperationSourceFileRefId").and_then(Value::as_str)
                    == canonical.get("previousCurrentFileRefId").and_then(Value::as_str)
                && canonical.get("previousCurrentFileRefId").and_then(Value::as_str)
                    == binding
                        .and_then(|value| value.get("currentFileRefId"))
                        .and_then(Value::as_str)
                && binding
                    .and_then(|value| value.get("ownerType"))
                    .and_then(Value::as_str)
                    == Some("experimentRun")
                && binding
                    .and_then(|value| value.get("ownerId"))
                    .and_then(Value::as_str)
                    == Some(owner_id)
                && binding
                    .and_then(|value| value.get("manuscriptChannel"))
                    .and_then(Value::as_str)
                    == Some("primary")
                && canonical.get("bindingPreserved").and_then(Value::as_bool) == Some(true)
                && canonical.get("defaultChanged").and_then(Value::as_bool) == Some(false)
                && canonical.get("readbackState").and_then(Value::as_str)
                    == Some("AUTHORITATIVE_RUN_FILE_REF_LIST_PHYSICAL_BODY_BINDING_PRESERVED")
        }
        Some("literature") => {
            let operation_prefix = match channel {
                "literature_outline" => "a17-lit-outline-man",
                "dedicated_notes" => "a18-lit-notes-man",
                _ => return false,
            };
            let expected_operation_id =
                format!("{operation_prefix}:{child_result_id}:{authorization_id}");
            let operation_generation = canonical
                .get("operationGeneration")
                .and_then(Value::as_u64)
                .filter(|generation| *generation > 0);
            let expected_candidate_request_id = operation_generation
                .map(|generation| format!("{expected_operation_id}:{generation}"));
            let expected_readback_state = if channel == "literature_outline" {
                "AUTHORITATIVE_LITERATURE_OUTLINE_FILE_REF_LIST_PHYSICAL_BODY_DUAL_CHANNEL_BINDING_PRESERVED"
            } else {
                "AUTHORITATIVE_LITERATURE_DEDICATED_NOTES_FILE_REF_LIST_PHYSICAL_BODY_DUAL_CHANNEL_BINDING_PRESERVED"
            };
            let outline_binding = canonical
                .get("outlineBindingReadback")
                .and_then(Value::as_object);
            let notes_binding = canonical
                .get("dedicatedNotesBindingReadback")
                .and_then(Value::as_object);
            let expected_source = if channel == "literature_outline" {
                canonical
                    .get("previousOutlineCurrentFileRefId")
                    .and_then(Value::as_str)
            } else {
                canonical
                    .get("previousDedicatedNotesCurrentFileRefId")
                    .and_then(Value::as_str)
            };
            canonical.get("literatureId").and_then(Value::as_str) == Some(owner_id)
                && canonical.get("primaryProjectId") == current.target.get("primaryProjectId")
                && canonical.get("resultId").and_then(Value::as_str)
                    == Some(child_result_id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(authorization_id)
                && lp14_a1_c4_bounded_fingerprint(
                    canonical.get("authorizationFingerprint").and_then(Value::as_str),
                )
                && canonical.get("operationId").and_then(Value::as_str)
                    == Some(expected_operation_id.as_str())
                && canonical.get("candidateRequestId").and_then(Value::as_str)
                    == expected_candidate_request_id.as_deref()
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == expected_payload_fingerprint.as_deref()
                && canonical.get("latestVisibleSourceBodyFingerprint")
                    == canonical.get("confirmedBodyFingerprint")
                && canonical.get("artifactAssociation").and_then(Value::as_str)
                    == Some("INDEPENDENT_MANAGED_MANUSCRIPT")
                && lp14_a1_c4_bounded_fingerprint(
                    canonical.get("targetIdentityDigest").and_then(Value::as_str),
                )
                && canonical.get("targetLocationMode").and_then(Value::as_str)
                    == Some("managed")
                && canonical.get("operationStage").and_then(Value::as_str)
                    == Some("completed")
                && canonical.get("d1CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("d2CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("preservationOperationSourceFileRefId").and_then(Value::as_str)
                    == expected_source
                && outline_binding
                    .and_then(|value| value.get("ownerType"))
                    .and_then(Value::as_str)
                    == Some("literature")
                && outline_binding
                    .and_then(|value| value.get("ownerId"))
                    .and_then(Value::as_str)
                    == Some(owner_id)
                && outline_binding
                    .and_then(|value| value.get("manuscriptChannel"))
                    .and_then(Value::as_str)
                    == Some("literature_outline")
                && notes_binding
                    .and_then(|value| value.get("ownerType"))
                    .and_then(Value::as_str)
                    == Some("literature")
                && notes_binding
                    .and_then(|value| value.get("ownerId"))
                    .and_then(Value::as_str)
                    == Some(owner_id)
                && notes_binding
                    .and_then(|value| value.get("manuscriptChannel"))
                    .and_then(Value::as_str)
                    == Some("dedicated_notes")
                && canonical.get("outlineBindingPreserved").and_then(Value::as_bool)
                    == Some(true)
                && canonical.get("dedicatedNotesPreserved").and_then(Value::as_bool)
                    == Some(true)
                && canonical.get("defaultChanged").and_then(Value::as_bool) == Some(false)
                && canonical.get("readbackState").and_then(Value::as_str)
                    == Some(expected_readback_state)
        }
        _ => false,
    }
}

fn lp14_a1_c4_legacy_parent_settlement_matches(
    current: &AIStandardResultRecord,
    authorization_id: &str,
    effect_receipt: &Value,
) -> bool {
    let requested_effects = current
        .confirmed_payload
        .as_ref()
        .and_then(|payload| payload.get("manuscriptEffects"))
        .and_then(Value::as_array);
    let settlement = effect_receipt.get("standardResultParentSettlement");
    let effects = match requested_effects {
        Some(value) if !value.is_empty() => value,
        _ => return settlement.is_none(),
    };
    if !matches!(current.action.as_str(), "CREATE" | "UPDATE") || effects.len() > 2 {
        return false;
    }
    let settlement = match settlement.and_then(Value::as_object) {
        Some(value) if value.len() == 6 => value,
        _ => return false,
    };
    let mut primary_business_receipt = effect_receipt.clone();
    if let Some(primary) = primary_business_receipt.as_object_mut() {
        primary.remove("standardResultParentSettlement");
    } else {
        return false;
    }
    let business_receipt = settlement.get("businessReceipt");
    let owner_id = primary_business_receipt
        .get("entityId")
        .and_then(Value::as_str);
    let requested_channels = settlement
        .get("requestedManuscriptEffects")
        .and_then(Value::as_array);
    let manuscript_receipts = settlement
        .get("manuscriptReceipts")
        .and_then(Value::as_array);
    if settlement.get("productAction").and_then(Value::as_str)
        != Some(current.action.as_str())
        || settlement.get("requestedBusinessEffect").and_then(Value::as_bool) != Some(true)
        || settlement.get("settledEffectCount").and_then(Value::as_u64)
            != Some((effects.len() + 1) as u64)
        || business_receipt != Some(&primary_business_receipt)
        || owner_id.is_none_or(|value| value.trim().is_empty())
        || requested_channels.is_none_or(|value| value.len() != effects.len())
        || manuscript_receipts.is_none_or(|value| value.len() != effects.len())
    {
        return false;
    }
    let owner_id = owner_id.unwrap();
    let requested_channels = requested_channels.unwrap();
    let manuscript_receipts = manuscript_receipts.unwrap();
    let mut observed_channels = BTreeSet::new();
    for (index, effect) in effects.iter().enumerate() {
        let effect = match effect.as_object() {
            Some(value) if value.len() == 2 => value,
            _ => return false,
        };
        let channel = match effect.get("channel").and_then(Value::as_str) {
            Some(value) if observed_channels.insert(value) => value,
            _ => return false,
        };
        let body = match effect.get("body").and_then(Value::as_str) {
            Some(value) if !value.trim().is_empty() && value.len() <= MAX_MESSAGE_CHARS => value,
            _ => return false,
        };
        if requested_channels[index].as_str() != Some(channel) {
            return false;
        }
        let manuscript_entry = match manuscript_receipts[index].as_object() {
            Some(value) if value.len() == 2 => value,
            _ => return false,
        };
        if manuscript_entry.get("channel").and_then(Value::as_str) != Some(channel)
            || !manuscript_entry.get("receipt").is_some_and(|receipt| {
                lp14_a1_c4_parent_manuscript_receipt_matches(
                    current,
                    authorization_id,
                    owner_id,
                    channel,
                    body,
                    receipt,
                )
            })
        {
            return false;
        }
    }
    true
}

fn lp14_a1_e5_shared_candidate_receipt_matches(
    current: &AIStandardResultRecord,
    authorization_id: &str,
    owner_id: &str,
    channel: &str,
    body: &str,
    receipt: &Value,
) -> bool {
    let receipt = match receipt.as_object() {
        Some(value) if value.len() == 6 => value,
        _ => return false,
    };
    let canonical = match receipt.get("canonicalReadback").and_then(Value::as_object) {
        Some(value) if value.len() == 39 => value,
        _ => return false,
    };
    let target_module = current.target.get("module").and_then(Value::as_str);
    let target_entity_type = current.target.get("entityType").and_then(Value::as_str);
    let target_project_id = current.target.get("projectId").and_then(Value::as_str);
    let child_result_id = format!("{}:manuscript:{channel}", current.id);
    let receipt_entity_id = receipt.get("entityId").and_then(Value::as_str);
    let expected_body_fingerprint =
        lp14_a1_c4_canonical_fingerprint(&Value::String(body.to_owned()));
    let binding = canonical.get("bindingBefore").and_then(Value::as_object);
    let candidate_path_identity = canonical
        .get("candidatePathIdentityKey")
        .and_then(Value::as_str);
    let candidate_directory_identity = canonical
        .get("candidateDirectoryPathIdentityKey")
        .and_then(Value::as_str);
    let exact_nonempty = |field: &str, max: usize| {
        canonical
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty() && value.len() <= max)
    };
    target_module == target_entity_type
        && receipt.get("module").and_then(Value::as_str) == target_module
        && receipt.get("entityType").and_then(Value::as_str) == Some("fileRef")
        && receipt_entity_id.is_some_and(|value| !value.trim().is_empty() && value.len() <= 200)
        && receipt.get("operation").and_then(Value::as_str) == Some("NEW_MANUSCRIPT")
        && receipt.get("service").and_then(Value::as_str)
            == Some("candidateManuscriptService.saveCandidate")
        && canonical.get("projectId").and_then(Value::as_str) == target_project_id
        && canonical.get("parentAction").and_then(Value::as_str)
            == Some(current.action.as_str())
        && canonical.get("parentResultId").and_then(Value::as_str)
            == Some(current.id.as_str())
        && canonical.get("effectResultId").and_then(Value::as_str)
            == Some(child_result_id.as_str())
        && canonical.get("parseCallAttemptId").and_then(Value::as_str)
            == Some(current.parse_call_attempt_id.as_str())
        && canonical.get("authorizationId").and_then(Value::as_str) == Some(authorization_id)
        && canonical.get("authorizationSource").and_then(Value::as_str)
            == Some("DERIVED_FROM_STANDARD_OPERATION_CONFIRMATION")
        && canonical.get("ownerType").and_then(Value::as_str) == target_module
        && canonical.get("ownerId").and_then(Value::as_str) == Some(owner_id)
        && canonical.get("manuscriptChannel").and_then(Value::as_str) == Some(channel)
        && canonical.get("candidateRequestId").and_then(Value::as_str)
            == Some(child_result_id.as_str())
        && canonical.get("candidateFileRefId").and_then(Value::as_str) == receipt_entity_id
        && exact_nonempty("candidatePath", 4000)
        && exact_nonempty("candidatePathIdentityKey", 4000)
        && exact_nonempty("candidateDirectoryPathIdentityKey", 4000)
        && candidate_path_identity
            .and_then(|value| value.rsplit_once('/').map(|(parent, _)| parent))
            == candidate_directory_identity
        && exact_nonempty("defaultFolderFileRefId", 200)
        && canonical.get("bindingBefore") == canonical.get("bindingAfter")
        && binding.is_some_and(|value| {
            value.len() == 8
                && value.get("ownerType").and_then(Value::as_str) == target_module
                && value.get("ownerId").and_then(Value::as_str) == Some(owner_id)
                && value.get("manuscriptChannel").and_then(Value::as_str) == Some(channel)
                && value.get("defaultFolderFileRefId").and_then(Value::as_str)
                    == canonical.get("defaultFolderFileRefId").and_then(Value::as_str)
                && value.get("currentFileRefId")
                    == canonical.get("currentFileRefIdBefore")
                && value.get("defaultManuscriptFileRefId")
                    == canonical.get("defaultManuscriptFileRefIdBefore")
        })
        && canonical.get("currentFileRefIdBefore") == canonical.get("currentFileRefIdAfter")
        && canonical.get("defaultManuscriptFileRefIdBefore")
            == canonical.get("defaultManuscriptFileRefIdAfter")
        && exact_nonempty("currentFileRefIdBefore", 200)
        && exact_nonempty("defaultManuscriptFileRefIdBefore", 200)
        && canonical.get("currentFileRefIdBefore").and_then(Value::as_str) != receipt_entity_id
        && canonical.get("defaultManuscriptFileRefIdBefore").and_then(Value::as_str)
            != receipt_entity_id
        && canonical.get("currentPathBefore") == canonical.get("currentPathAfter")
        && canonical.get("defaultPathBefore") == canonical.get("defaultPathAfter")
        && exact_nonempty("currentPathBefore", 4000)
        && exact_nonempty("defaultPathBefore", 4000)
        && canonical.get("candidatePath") != canonical.get("currentPathBefore")
        && canonical.get("candidatePath") != canonical.get("defaultPathBefore")
        && canonical.get("currentExactBytesPreserved").and_then(Value::as_bool) == Some(true)
        && canonical.get("defaultExactBytesPreserved").and_then(Value::as_bool) == Some(true)
        && canonical.get("bindingPreserved").and_then(Value::as_bool) == Some(true)
        && canonical.get("candidateDistinctFromCurrentAndDefault").and_then(Value::as_bool)
            == Some(true)
        && canonical.get("currentChanged").and_then(Value::as_bool) == Some(false)
        && canonical.get("defaultChanged").and_then(Value::as_bool) == Some(false)
        && canonical.get("formalSwitchInvoked").and_then(Value::as_bool) == Some(false)
        && canonical.get("confirmedBodyFingerprint").and_then(Value::as_str)
            == expected_body_fingerprint.as_deref()
        && canonical.get("physicalBodyFingerprint").and_then(Value::as_str)
            == expected_body_fingerprint.as_deref()
        && canonical.get("physicalEncoding").and_then(Value::as_str) == Some("utf-8")
        && canonical.get("physicalSizeBytes").and_then(Value::as_u64).is_some_and(|value| value > 0)
        && canonical.get("bodyNormalization").and_then(Value::as_str)
            == Some("CRLF_TO_LF_AT_STANDARD_RESULT_ADMISSION")
        && canonical.get("terminalCommitState").and_then(Value::as_str)
            == Some("POST_PUBLISH_FILE_REF_PHYSICAL_AND_PROTECTED_BYTES_CONFIRMED")
}

fn lp14_a1_e5_parent_settlement_matches(
    current: &AIStandardResultRecord,
    authorization_id: &str,
    effect_receipt: &Value,
) -> bool {
    let effects = match current
        .confirmed_payload
        .as_ref()
        .and_then(|payload| payload.get("manuscriptEffects"))
        .and_then(Value::as_array)
    {
        Some(value) if !value.is_empty() && value.len() <= 2 => value,
        _ => return false,
    };
    let settlement = match effect_receipt
        .get("standardResultParentSettlement")
        .and_then(Value::as_object)
    {
        Some(value) if value.len() == 11 => value,
        _ => return false,
    };
    let mut root_receipt = effect_receipt.clone();
    if let Some(value) = root_receipt.as_object_mut() {
        value.remove("standardResultParentSettlement");
    } else {
        return false;
    }
    let root = root_receipt.as_object().unwrap();
    let owner_id = match root.get("entityId").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() && value.len() <= 200 => value,
        _ => return false,
    };
    if root.get("module").and_then(Value::as_str)
        != current.target.get("module").and_then(Value::as_str)
        || root.get("entityType").and_then(Value::as_str)
            != current.target.get("entityType").and_then(Value::as_str)
        || root.get("operation").and_then(Value::as_str) != Some(current.action.as_str())
    {
        return false;
    }
    let requested_business = match settlement.get("requestedBusinessEffect").and_then(Value::as_bool) {
        Some(value) => value,
        None => return false,
    };
    let actual_business_requested = match current.confirmed_payload.as_ref().and_then(Value::as_object) {
        Some(payload) => {
            current.action == "CREATE" ||
                current.action == "UPDATE" && payload.keys().any(|key| key != "manuscriptEffects")
        }
        None => return false,
    };
    if requested_business != actual_business_requested {
        return false;
    }
    let mut expected_target = current.target.clone();
    if current.action == "CREATE" {
        let target = match expected_target.as_object_mut() {
            Some(value) => value,
            None => return false,
        };
        target.insert("entityId".into(), Value::String(owner_id.into()));
    }
    if settlement.get("parentResultId").and_then(Value::as_str) != Some(current.id.as_str())
        || settlement.get("productAction").and_then(Value::as_str) != Some(current.action.as_str())
        || settlement.get("settledTarget") != Some(&expected_target)
        || settlement.get("requestedManuscriptEffects").and_then(Value::as_array)
            .is_none_or(|value| value.len() != effects.len())
        || settlement.get("manuscriptOutcomes").and_then(Value::as_array)
            .is_none_or(|value| value.len() != effects.len())
        || settlement.get("manuscriptReceipts").and_then(Value::as_array).is_none()
    {
        return false;
    }
    if requested_business {
        if settlement.get("businessOutcome").and_then(Value::as_str) != Some("PROVEN_SUCCESS")
            || settlement.get("businessReceipt") != Some(&root_receipt)
            || root.get("service").and_then(Value::as_str)
                == Some("aiStandardResultAdapterService.aggregateParentReceipt")
        {
            return false;
        }
    } else if current.action != "UPDATE"
        || settlement.get("businessOutcome").and_then(Value::as_str) != Some("NOT_REQUESTED")
        || !settlement.get("businessReceipt").is_some_and(Value::is_null)
        || root.get("service").and_then(Value::as_str)
            != Some("aiStandardResultAdapterService.aggregateParentReceipt")
        || current.target.get("entityId").and_then(Value::as_str) != Some(owner_id)
    {
        return false;
    }

    let requested_channels = settlement
        .get("requestedManuscriptEffects")
        .and_then(Value::as_array)
        .unwrap();
    let outcomes = settlement.get("manuscriptOutcomes").and_then(Value::as_array).unwrap();
    let receipts = settlement.get("manuscriptReceipts").and_then(Value::as_array).unwrap();
    let mut channels = BTreeSet::new();
    let mut successful_receipts = 0usize;
    let mut failures = 0usize;
    let mut not_reached = 0usize;
    let mut failure_seen = false;
    for (index, effect) in effects.iter().enumerate() {
        let effect = match effect.as_object() {
            Some(value) if value.len() == 2 => value,
            _ => return false,
        };
        let channel = match effect.get("channel").and_then(Value::as_str) {
            Some(value) if channels.insert(value) => value,
            _ => return false,
        };
        let body = match effect.get("body").and_then(Value::as_str) {
            Some(value) if !value.trim().is_empty() && value.len() <= MAX_MESSAGE_CHARS => value,
            _ => return false,
        };
        let effect_result_id = format!("{}:manuscript:{channel}", current.id);
        let outcome = match outcomes[index].as_object() {
            Some(value) if value.len() == 6 => value,
            _ => return false,
        };
        if requested_channels[index].as_str() != Some(channel)
            || outcome.get("channel").and_then(Value::as_str) != Some(channel)
            || outcome.get("effectResultId").and_then(Value::as_str)
                != Some(effect_result_id.as_str())
        {
            return false;
        }
        match outcome.get("outcome").and_then(Value::as_str) {
            Some("PROVEN_SUCCESS") if !failure_seen => {
                let receipt = match outcome.get("receipt") {
                    Some(value) if lp14_a1_e5_shared_candidate_receipt_matches(
                        current,
                        authorization_id,
                        owner_id,
                        channel,
                        body,
                        value,
                    ) => value,
                    _ => return false,
                };
                if !outcome.get("failureCode").is_some_and(Value::is_null)
                    || !outcome.get("failureMessage").is_some_and(Value::is_null)
                {
                    return false;
                }
                let receipt_entry = match receipts.get(successful_receipts).and_then(Value::as_object) {
                    Some(value) if value.len() == 2 => value,
                    _ => return false,
                };
                if receipt_entry.get("channel").and_then(Value::as_str) != Some(channel)
                    || receipt_entry.get("receipt") != Some(receipt)
                {
                    return false;
                }
                successful_receipts += 1;
            }
            Some("PROVEN_NO_EFFECT_FAILURE") if !failure_seen => {
                failure_seen = true;
                failures += 1;
                if !outcome.get("receipt").is_some_and(Value::is_null)
                    || !outcome.get("failureCode").and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty() && value.len() <= 200)
                    || !outcome.get("failureMessage").and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty() && value.len() <= 4000)
                {
                    return false;
                }
            }
            Some("NOT_REACHED") if failure_seen => {
                not_reached += 1;
                if !outcome.get("receipt").is_some_and(Value::is_null)
                    || !outcome.get("failureCode").is_some_and(Value::is_null)
                    || !outcome.get("failureMessage").is_some_and(Value::is_null)
                {
                    return false;
                }
            }
            _ => return false,
        }
    }
    if receipts.len() != successful_receipts
        || settlement.get("settledEffectCount").and_then(Value::as_u64)
            != Some((successful_receipts + usize::from(requested_business)) as u64)
    {
        return false;
    }
    match settlement.get("outcomeClass").and_then(Value::as_str) {
        Some("FULL_SUCCESS") => failures == 0 && not_reached == 0 && successful_receipts == effects.len(),
        Some("PROVEN_PARTIAL") => {
            failures == 1
                && successful_receipts + usize::from(requested_business) > 0
                && successful_receipts + failures + not_reached == effects.len()
        }
        _ => false,
    }
}

fn lp14_a1_f27_structured_text_object_matches(value: Option<&Value>, keys: &[&str]) -> bool {
    let object = match value.and_then(Value::as_object) {
        Some(value) if value.len() == keys.len() => value,
        _ => return false,
    };
    keys.iter().all(|key| {
        object.get(*key).is_some_and(|value| {
            value.is_null()
                || value.as_str().is_some_and(|text| text.len() <= MAX_MESSAGE_CHARS)
        })
    })
}

fn lp14_a1_f27_literature_structured_state_matches(canonical: &Value) -> bool {
    let structured = match canonical.get("structuredState").and_then(Value::as_object) {
        Some(value) if value.len() == 2 => value,
        _ => return false,
    };
    lp14_a1_f27_structured_text_object_matches(
        structured.get("literature_outline"),
        &[
            "research_problem",
            "application_object",
            "method_overview",
            "main_conclusion",
            "limitations",
            "other",
        ],
    ) && lp14_a1_f27_structured_text_object_matches(
        structured.get("dedicated_notes"),
        &[
            "summary",
            "project_relevance",
            "related_objects",
            "reusable_methods",
            "comparable_conclusions",
            "other",
        ],
    )
}

fn lp14_a1_c4_parent_settlement_matches(
    current: &AIStandardResultRecord,
    authorization_id: &str,
    effect_receipt: &Value,
) -> bool {
    if effect_receipt
        .get("standardResultParentSettlement")
        .and_then(|value| value.get("outcomeClass"))
        .is_some()
    {
        lp14_a1_e5_parent_settlement_matches(current, authorization_id, effect_receipt)
    } else {
        lp14_a1_c4_legacy_parent_settlement_matches(current, authorization_id, effect_receipt)
    }
}

pub(crate) fn settle_ai_standard_result_effect_in_connection(
    connection: &mut Connection,
    input: &SettleAIStandardResultEffectInput,
) -> Result<AIConversationReadback, String> {
    for (value, field, max) in [
        (&input.conversation_id, "conversationId", 200),
        (&input.result_id, "resultId", 200),
        (&input.authorization_id, "authorizationId", 200),
        (&input.settled_at, "settledAt", 80),
    ] {
        require_text(value, field, max)?;
    }
    let receipt_module = required_json_text_field(&input.effect_receipt, "module")?;
    let receipt_entity_type = required_json_text_field(&input.effect_receipt, "entityType")?;
    let receipt_entity_id = required_json_text_field(&input.effect_receipt, "entityId")?;
    let receipt_operation = required_json_text_field(&input.effect_receipt, "operation")?;
    let receipt_service = required_json_text_field(&input.effect_receipt, "service")?;
    let aggregate_root_receipt = receipt_operation == "UPDATE"
        && receipt_service == "aiStandardResultAdapterService.aggregateParentReceipt"
        && receipt_module == receipt_entity_type;
    let valid_receipt_tuple = aggregate_root_receipt || matches!(
        (receipt_module, receipt_entity_type, receipt_operation, receipt_service),
        ("route", "routeNode", "CREATE", "planningService.createRouteNode")
            | ("route", "routeNode", "UPDATE", "planningService.updateRouteNode")
            | ("task", "task", "CREATE", "planningService.createTask")
            | ("task", "task", "UPDATE", "planningService.updateTask")
            | ("finding", "finding", "CREATE", "outputConversionService.createFinding")
            | ("finding", "finding", "UPDATE", "outputConversionService.updateFinding")
            | ("resultItem", "resultItem", "CREATE", "outputConversionService.createResultItem")
            | ("resultItem", "resultItem", "UPDATE", "outputConversionService.updateResultItem")
            | ("outputCandidate", "outputCandidate", "CREATE", "outputConversionService.createOutputCandidate")
            | ("outputCandidate", "outputCandidate", "UPDATE", "outputConversionService.updateOutputCandidate")
            | ("outputGap", "outputGap", "CREATE", "outputConversionService.createOutputGapForDeposition")
            | ("outputGap", "outputGap", "UPDATE", "outputConversionService.updateOutputGap")
            | ("researchOutput", "researchOutput", "CREATE", "outputService.create")
            | ("researchOutput", "researchOutput", "UPDATE", "outputService.update")
            | ("review", "review", "CREATE", "planningService.createReviewWithTargets")
            | ("review", "review", "UPDATE", "planningService.updateReview")
            | ("review", "fileRef", "NEW_MANUSCRIPT", "reviewCandidateService.saveCandidate")
            | ("experiment", "experiment", "CREATE", "experimentService.createExperiment")
            | ("experiment", "experiment", "UPDATE", "experimentService.updateExperiment")
            | ("experiment", "fileRef", "NEW_MANUSCRIPT", "experimentManuscriptSaveAsAdapter.saveAs")
            | (
                "experiment" | "experimentRun" | "literature" | "review" | "resultItem"
                    | "finding" | "outputCandidate" | "outputGap" | "researchOutput",
                "fileRef",
                "NEW_MANUSCRIPT",
                "candidateManuscriptService.saveCandidate"
            )
            | ("experimentRun", "experimentRun", "CREATE", "experimentRunService.createExperimentRun")
            | ("experimentRun", "experimentRun", "UPDATE", "experimentRunService.updateExperimentRun")
            | ("experimentRun", "fileRef", "NEW_MANUSCRIPT", "experimentRunManuscriptSaveAsAdapter.saveAs")
            | ("literature", "literature", "CREATE", "literatureService.createLiteratureWithOperation")
            | ("literature", "literature", "UPDATE", "literatureService.updateLiteratureWithExpectedUpdatedAtAndOperation")
            | ("literature", "fileRef", "NEW_MANUSCRIPT", "literatureManuscriptSaveAsAdapter.saveAs")
    );
    if !input.effect_receipt.is_object()
        || receipt_entity_id.len() > 200
        || !valid_receipt_tuple
        || !input.effect_receipt.get("canonicalReadback").is_some_and(Value::is_object)
    {
        return Err(fail(
            "AI_STANDARD_RESULT_EFFECT_INVALID",
            "The durable Standard Result effect receipt is invalid",
        ));
    }
    let receipt_json = json_text(&input.effect_receipt, "effectReceipt")?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    let current = standard_result_for_conversation(
        &transaction,
        &input.conversation_id,
        &input.result_id,
    )?;
    let target_project_id = required_json_text_field(&current.target, "projectId")?;
    let target_module = required_json_text_field(&current.target, "module")?;
    let target_entity_type = required_json_text_field(&current.target, "entityType")?;
    let receipt_project_id = input
        .effect_receipt
        .get("canonicalReadback")
        .and_then(|value| value.get("projectId"))
        .and_then(Value::as_str);
    let canonical = input.effect_receipt.get("canonicalReadback").unwrap();
    let target_entity_id = current.target.get("entityId").and_then(Value::as_str);
    let same_batch_run_parent_entity_id = if target_module == "experimentRun"
        && current.action == "CREATE"
        && current
            .target
            .get("parentExperimentId")
            .and_then(Value::as_str)
            .is_none()
    {
        confirmed_same_batch_experiment_parent_entity_id(&transaction, &current)?
    } else {
        None
    };
    let expected_run_parent_entity_id = current
        .target
        .get("parentExperimentId")
        .and_then(Value::as_str)
        .or(same_batch_run_parent_entity_id.as_deref());
    let receipt_matches_target = match (
        receipt_module,
        receipt_entity_type,
        receipt_operation,
        receipt_service,
    ) {
        (
            receipt_owner,
            receipt_entity_type,
            "UPDATE",
            "aiStandardResultAdapterService.aggregateParentReceipt",
        ) => {
            receipt_owner == receipt_entity_type
                && target_module == receipt_owner
                && target_entity_type == receipt_entity_type
                && target_entity_id == Some(receipt_entity_id)
                && canonical.as_object().is_some_and(|readback| readback.len() == 5)
                && canonical.get("projectId").and_then(Value::as_str)
                    == Some(target_project_id)
                && canonical.get("parentResultId").and_then(Value::as_str)
                    == Some(current.id.as_str())
                && canonical.get("parentAction").and_then(Value::as_str) == Some("UPDATE")
                && canonical.get("parentTarget") == input
                    .effect_receipt
                    .get("standardResultParentSettlement")
                    .and_then(|value| value.get("settledTarget"))
                && canonical.get("requestedBusinessEffect").and_then(Value::as_bool)
                    == Some(false)
        }
        ("route", "routeNode", "CREATE", "planningService.createRouteNode") => {
            target_module == "route"
                && target_entity_type == "routeNode"
                && target_entity_id.is_none()
                && canonical.as_object().is_some_and(|readback| readback.len() == 15)
                && canonical.get("id").and_then(Value::as_str) == Some(receipt_entity_id)
                && canonical.get("projectId").and_then(Value::as_str) == Some(target_project_id)
        }
        ("route", "routeNode", "UPDATE", "planningService.updateRouteNode") => {
            target_module == "route"
                && target_entity_type == "routeNode"
                && target_entity_id == Some(receipt_entity_id)
                && canonical.as_object().is_some_and(|readback| readback.len() == 15)
                && canonical.get("id").and_then(Value::as_str) == Some(receipt_entity_id)
                && canonical.get("projectId").and_then(Value::as_str) == Some(target_project_id)
        }
        ("task", "task", "CREATE", "planningService.createTask") => {
            target_module == "task" && target_entity_type == "task"
        }
        ("task", "task", "UPDATE", "planningService.updateTask") => {
            target_module == "task"
                && target_entity_type == "task"
                && target_entity_id == Some(receipt_entity_id)
        }
        (
            receipt_owner @ (
                "resultItem" | "finding" | "outputCandidate" | "outputGap"
                    | "researchOutput"
            ),
            receipt_entity_type,
            operation @ ("CREATE" | "UPDATE"),
            service,
        ) => {
            let expected_service = match (receipt_owner, operation) {
                ("resultItem", "CREATE") => "outputConversionService.createResultItem",
                ("resultItem", "UPDATE") => "outputConversionService.updateResultItem",
                ("finding", "CREATE") => "outputConversionService.createFinding",
                ("finding", "UPDATE") => "outputConversionService.updateFinding",
                ("outputCandidate", "CREATE") => "outputConversionService.createOutputCandidate",
                ("outputCandidate", "UPDATE") => "outputConversionService.updateOutputCandidate",
                ("outputGap", "CREATE") => "outputConversionService.createOutputGapForDeposition",
                ("outputGap", "UPDATE") => "outputConversionService.updateOutputGap",
                ("researchOutput", "CREATE") => "outputService.create",
                ("researchOutput", "UPDATE") => "outputService.update",
                _ => "",
            };
            service == expected_service
                && receipt_entity_type == receipt_owner
                && target_module == receipt_owner
                && target_entity_type == receipt_owner
                && (if operation == "CREATE" {
                    target_entity_id.is_none()
                } else {
                    target_entity_id == Some(receipt_entity_id)
                })
                && canonical.as_object().is_some_and(|readback| readback.len() == 9)
                && canonical.get("id").and_then(Value::as_str) == Some(receipt_entity_id)
                && canonical.get("projectId").and_then(Value::as_str) == Some(target_project_id)
                && canonical.get("resultId").and_then(Value::as_str)
                    == Some(current.id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(input.authorization_id.as_str())
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == current.confirmed_payload_fingerprint.as_deref()
                && canonical.get("title").and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty() && value.len() <= 800)
                && canonical.get("brief").is_some_and(Value::is_string)
                && canonical.get("structuredSummary").is_some_and(Value::is_array)
                && canonical.get("updatedAt").and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty() && value.len() <= 80)
        }
        ("review", "review", "CREATE", "planningService.createReviewWithTargets") => {
            target_module == "review"
                && target_entity_type == "review"
                && target_entity_id.is_none()
                && canonical.get("id").and_then(Value::as_str) == Some(receipt_entity_id)
        }
        ("review", "review", "UPDATE", "planningService.updateReview") => {
            target_module == "review"
                && target_entity_type == "review"
                && target_entity_id == Some(receipt_entity_id)
                && canonical.get("id").and_then(Value::as_str) == Some(receipt_entity_id)
                && canonical.get("projectId").and_then(Value::as_str) == Some(target_project_id)
                && canonical.get("resultCorrelationId").and_then(Value::as_str)
                    == Some(current.id.as_str())
        }
        ("review", "fileRef", "NEW_MANUSCRIPT", "reviewCandidateService.saveCandidate") => {
            target_module == "review"
                && target_entity_type == "review"
                && target_entity_id == canonical.get("reviewId").and_then(Value::as_str)
                && current.target.get("manuscriptChannel").and_then(Value::as_str) == Some("primary")
                && canonical.get("manuscriptChannel").and_then(Value::as_str) == Some("primary")
                && canonical.get("operationId").and_then(Value::as_str) == Some(current.id.as_str())
                && canonical.get("candidateRequestId").and_then(Value::as_str) == Some(current.id.as_str())
                && canonical.get("fileRefId").and_then(Value::as_str) == Some(receipt_entity_id)
        }
        ("experiment", "experiment", "CREATE", "experimentService.createExperiment") => {
            target_module == "experiment"
                && target_entity_type == "experiment"
                && target_entity_id.is_none()
                && canonical.get("id").and_then(Value::as_str) == Some(receipt_entity_id)
                && canonical.get("operationId").and_then(Value::as_str) == Some(current.id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(input.authorization_id.as_str())
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == current.confirmed_payload_fingerprint.as_deref()
        }
        ("experiment", "experiment", "UPDATE", "experimentService.updateExperiment") => {
            target_module == "experiment"
                && target_entity_type == "experiment"
                && target_entity_id == Some(receipt_entity_id)
                && canonical.get("id").and_then(Value::as_str) == Some(receipt_entity_id)
                && canonical.get("operationId").and_then(Value::as_str) == Some(current.id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(input.authorization_id.as_str())
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == current.confirmed_payload_fingerprint.as_deref()
        }
        (
            "experimentRun",
            "experimentRun",
            "CREATE",
            "experimentRunService.createExperimentRun",
        ) => {
            target_module == "experimentRun"
                && target_entity_type == "experimentRun"
                && target_entity_id.is_none()
                && canonical.get("id").and_then(Value::as_str) == Some(receipt_entity_id)
                && canonical.get("experimentId").and_then(Value::as_str)
                    == expected_run_parent_entity_id
                && canonical.get("operationId").and_then(Value::as_str)
                    == Some(current.id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(input.authorization_id.as_str())
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == current.confirmed_payload_fingerprint.as_deref()
        }
        (
            "experimentRun",
            "experimentRun",
            "UPDATE",
            "experimentRunService.updateExperimentRun",
        ) => {
            target_module == "experimentRun"
                && target_entity_type == "experimentRun"
                && target_entity_id == Some(receipt_entity_id)
                && canonical.get("id").and_then(Value::as_str) == Some(receipt_entity_id)
                && canonical.get("experimentId").and_then(Value::as_str)
                    == current.target.get("parentExperimentId").and_then(Value::as_str)
                && canonical.get("operationId").and_then(Value::as_str)
                    == Some(current.id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(input.authorization_id.as_str())
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == current.confirmed_payload_fingerprint.as_deref()
        }
        (
            "literature",
            "literature",
            operation @ ("CREATE" | "UPDATE"),
            service,
        ) => {
            let expected_service = if operation == "CREATE" {
                "literatureService.createLiteratureWithOperation"
            } else {
                "literatureService.updateLiteratureWithExpectedUpdatedAtAndOperation"
            };
            let expected_operation_key = format!(
                "a16-lit-{}:{}:{}",
                operation.to_ascii_lowercase(),
                current.id,
                input.authorization_id
            );
            let canonical_primary_project_id = canonical.get("primaryProjectId");
            let target_primary_project_id = current.target.get("primaryProjectId");
            let updated_at = canonical.get("updatedAt").and_then(Value::as_str);
            let applied_updated_at = canonical.get("appliedUpdatedAt").and_then(Value::as_str);
            let update_token_advanced = if operation == "UPDATE" {
                current.target.get("expectedUpdatedAt").and_then(Value::as_str)
                    .zip(updated_at)
                    .is_some_and(|(expected, applied)| applied > expected)
            } else {
                current.target.get("expectedUpdatedAt").is_none()
            };
            service == expected_service
                && target_module == "literature"
                && target_entity_type == "literature"
                && canonical.as_object().is_some_and(|readback| readback.len() == 21)
                && lp14_a1_f27_literature_structured_state_matches(canonical)
                && canonical.get("id").and_then(Value::as_str) == Some(receipt_entity_id)
                && canonical.get("projectId").and_then(Value::as_str) == Some(target_project_id)
                && canonical_primary_project_id == target_primary_project_id
                && canonical.get("operationKey").and_then(Value::as_str)
                    == Some(expected_operation_key.as_str())
                && canonical.get("resultId").and_then(Value::as_str)
                    == Some(current.id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(input.authorization_id.as_str())
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == current.confirmed_payload_fingerprint.as_deref()
                && updated_at.is_some_and(|value| !value.trim().is_empty() && value.len() <= 80)
                && applied_updated_at == updated_at
                && canonical.get("authorNames").is_some_and(Value::is_array)
                && canonical.get("keywords").is_some_and(Value::is_array)
                && canonical.get("tags").is_some_and(Value::is_array)
                && canonical.get("title").and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                && update_token_advanced
                && if operation == "CREATE" {
                    target_entity_id.is_none()
                        && target_primary_project_id.is_some_and(Value::is_null)
                        && canonical_primary_project_id.is_some_and(Value::is_null)
                } else {
                    target_entity_id == Some(receipt_entity_id)
                }
        }
        (
            "experiment",
            "fileRef",
            "NEW_MANUSCRIPT",
            "experimentManuscriptSaveAsAdapter.saveAs",
        ) => {
            let expected_operation_id = format!(
                "a11-exp-man:{}:{}",
                current.id, input.authorization_id
            );
            let operation_generation = canonical
                .get("operationGeneration")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0);
            let expected_candidate_request_id = operation_generation
                .map(|generation| format!("{}:{}", expected_operation_id, generation));
            let confirmed_body_fingerprint = canonical
                .get("confirmedBodyFingerprint")
                .and_then(Value::as_str);
            let source_file_ref_id = canonical
                .get("sourceFileRefId")
                .and_then(Value::as_str);
            let source_path_identity_key = canonical
                .get("sourcePathIdentityKey")
                .and_then(Value::as_str);
            let source_directory_path_identity_key = canonical
                .get("sourceDirectoryPathIdentityKey")
                .and_then(Value::as_str);
            let candidate_path_identity_key = canonical
                .get("candidatePathIdentityKey")
                .and_then(Value::as_str);
            let candidate_directory_path_identity_key = canonical
                .get("candidateDirectoryPathIdentityKey")
                .and_then(Value::as_str);
            target_module == "experiment"
                && target_entity_type == "experiment"
                && target_entity_id == canonical.get("experimentId").and_then(Value::as_str)
                && current.target.get("manuscriptChannel").and_then(Value::as_str)
                    == Some("primary")
                && canonical.get("manuscriptChannel").and_then(Value::as_str)
                    == Some("primary")
                && canonical.get("resultId").and_then(Value::as_str)
                    == Some(current.id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(input.authorization_id.as_str())
                && canonical.get("operationId").and_then(Value::as_str)
                    == Some(expected_operation_id.as_str())
                && operation_generation.is_some()
                && canonical.get("candidateRequestId").and_then(Value::as_str)
                    == expected_candidate_request_id.as_deref()
                && canonical.get("candidateOccurredAt").and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty() && value.len() <= 80)
                && canonical.get("fileRefId").and_then(Value::as_str)
                    == Some(receipt_entity_id)
                && source_file_ref_id.is_some_and(|value| {
                    !value.trim().is_empty() && value != receipt_entity_id
                })
                && source_path_identity_key.is_some_and(|value| !value.trim().is_empty())
                && candidate_path_identity_key.is_some_and(|value| {
                    !value.trim().is_empty() && Some(value) != source_path_identity_key
                })
                && source_directory_path_identity_key
                    .is_some_and(|value| !value.trim().is_empty())
                && candidate_directory_path_identity_key
                    == source_directory_path_identity_key
                && canonical.get("resourceKind").and_then(Value::as_str) == Some("file")
                && canonical.get("fileRole").and_then(Value::as_str) == Some("manuscript")
                && canonical.get("targetLocationMode").and_then(Value::as_str)
                    == Some("managed")
                && canonical.get("operationStage").and_then(Value::as_str)
                    == Some("completed")
                && canonical.get("d1CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("d2CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == current.confirmed_payload_fingerprint.as_deref()
                && confirmed_body_fingerprint.is_some_and(|value| !value.is_empty())
                && confirmed_body_fingerprint
                    == canonical.get("physicalBodyFingerprint").and_then(Value::as_str)
                && canonical.get("physicalEncoding").and_then(Value::as_str) == Some("utf-8")
                && canonical.get("documentLineEnding").and_then(Value::as_str) == Some("LF")
                && canonical.get("bindingPreserved").and_then(Value::as_bool) == Some(true)
                && canonical.get("currentChanged").and_then(Value::as_bool) == Some(false)
                && canonical.get("defaultChanged").and_then(Value::as_bool) == Some(false)
                && canonical.get("formalSwitchInvoked").and_then(Value::as_bool) == Some(false)
                && canonical.get("readbackState").and_then(Value::as_str)
                    == Some("AUTHORITATIVE_FILE_REF_LIST_PHYSICAL_BODY_BINDING_PRESERVED")
        }
        (
            receipt_owner @ (
                "experiment" | "experimentRun" | "literature" | "review" | "resultItem"
                    | "finding" | "outputCandidate" | "outputGap" | "researchOutput"
            ),
            "fileRef",
            "NEW_MANUSCRIPT",
            "candidateManuscriptService.saveCandidate",
        ) => {
            let expected_operation_id = format!(
                "qa-candidate:{}:{}",
                current.id, input.authorization_id
            );
            let quick_analysis_run_id = canonical
                .get("quickAnalysisRunId")
                .and_then(Value::as_str);
            let expected_authorization_id = quick_analysis_run_id
                .map(|run_id| format!("quick-analysis-run-authorization:{run_id}"));
            let source_file_ref_id = canonical
                .get("sourceFileRefId")
                .and_then(Value::as_str);
            let source_directory_file_ref_id = canonical
                .get("sourceDirectoryFileRefId")
                .and_then(Value::as_str);
            let binding_before = canonical
                .get("bindingBefore")
                .and_then(Value::as_object);
            let binding_after = canonical
                .get("bindingAfter")
                .and_then(Value::as_object);
            let target_channel = current
                .target
                .get("manuscriptChannel")
                .and_then(Value::as_str);
            let quick_target = current
                .source
                .get("quickAnalysisTarget")
                .and_then(Value::as_object);
            let binding_identity_is_exact = binding_before.is_some_and(|binding| {
                binding.len() == 8
                    && binding.get("id").and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
                    && binding.get("ownerType").and_then(Value::as_str)
                        == Some(receipt_owner)
                    && binding.get("ownerId").and_then(Value::as_str)
                        == target_entity_id
                    && binding.get("manuscriptChannel").and_then(Value::as_str)
                        == target_channel
                    && binding.get("defaultFolderFileRefId").and_then(Value::as_str)
                        == source_directory_file_ref_id
                    && binding.get("currentFileRefId").and_then(Value::as_str)
                        == source_file_ref_id
                    && binding.get("updatedAt").and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
                    && binding.get("currentFileRefId").and_then(Value::as_str)
                        != Some(receipt_entity_id)
                    && binding.get("defaultManuscriptFileRefId").and_then(Value::as_str)
                        != Some(receipt_entity_id)
            });
            let quick_target_is_exact = quick_target.is_some_and(|quick| {
                quick.len() == 7
                    && quick.get("ownerType").and_then(Value::as_str) == Some(receipt_owner)
                    && quick.get("ownerId").and_then(Value::as_str) == target_entity_id
                    && quick.get("channel").and_then(Value::as_str) == target_channel
                    && quick.get("projectOrScopeId").and_then(Value::as_str)
                        == Some(target_project_id)
                    && quick.get("sourceFileRefId").and_then(Value::as_str)
                        == source_file_ref_id
                    && quick.get("sourceDirectoryFileRefId").and_then(Value::as_str)
                        == source_directory_file_ref_id
                    && quick.get("whitelistFingerprint").and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty() && value.len() <= 200)
            });
            let sibling_before = canonical.get("literatureSiblingBindingBefore");
            let sibling_after = canonical.get("literatureSiblingBindingAfter");
            let sibling_channel = canonical
                .get("literatureSiblingChannel")
                .and_then(Value::as_str);
            let expected_sibling_channel = match target_channel {
                Some("literature_outline") => Some("dedicated_notes"),
                Some("dedicated_notes") => Some("literature_outline"),
                _ => None,
            };
            let literature_sibling_is_exact = if receipt_owner == "literature" {
                let sibling_binding = sibling_before.and_then(Value::as_object);
                sibling_channel == expected_sibling_channel
                    && sibling_before == sibling_after
                    && sibling_binding.is_some_and(|binding| {
                        binding.len() == 8
                            && binding.get("id").and_then(Value::as_str)
                                .is_some_and(|value| !value.trim().is_empty())
                            && binding.get("ownerType").and_then(Value::as_str)
                                == Some("literature")
                            && binding.get("ownerId").and_then(Value::as_str)
                                == target_entity_id
                            && binding.get("manuscriptChannel").and_then(Value::as_str)
                                == expected_sibling_channel
                            && binding.get("updatedAt").and_then(Value::as_str)
                                .is_some_and(|value| !value.trim().is_empty())
                    })
            } else {
                canonical.get("literatureSiblingChannel").is_some_and(Value::is_null)
                    && sibling_before.is_some_and(Value::is_null)
                    && sibling_after.is_some_and(Value::is_null)
            };
            target_module == receipt_owner
                && target_entity_type == receipt_owner
                && canonical.as_object().is_some_and(|readback| readback.len() == 39)
                && target_entity_id == canonical.get("ownerId").and_then(Value::as_str)
                && canonical.get("ownerType").and_then(Value::as_str) == Some(receipt_owner)
                && canonical.get("projectId").and_then(Value::as_str)
                    == Some(target_project_id)
                && canonical.get("manuscriptChannel").and_then(Value::as_str)
                    == target_channel
                && is_canonical_quick_analysis_owner_channel(receipt_owner, target_channel)
                && quick_target_is_exact
                && canonical.get("resultId").and_then(Value::as_str)
                    == Some(current.id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(input.authorization_id.as_str())
                && canonical.get("authorizationSource").and_then(Value::as_str)
                    == Some("DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION")
                && quick_analysis_run_id.is_some_and(|value| !value.trim().is_empty())
                && expected_authorization_id.as_deref()
                    == Some(input.authorization_id.as_str())
                && canonical.get("operationId").and_then(Value::as_str)
                    == Some(expected_operation_id.as_str())
                && canonical.get("candidateRequestId").and_then(Value::as_str)
                    == Some(current.id.as_str())
                && canonical.get("fileRefId").and_then(Value::as_str)
                    == Some(receipt_entity_id)
                && canonical.get("resourceKind").and_then(Value::as_str) == Some("file")
                && canonical.get("fileRole").and_then(Value::as_str) == Some("manuscript")
                && canonical.get("locationMode").and_then(Value::as_str) == Some("managed")
                && source_file_ref_id.is_some_and(|value| !value.trim().is_empty())
                && source_file_ref_id != Some(receipt_entity_id)
                && source_directory_file_ref_id
                    .is_some_and(|value| !value.trim().is_empty())
                && canonical.get("candidateDirectoryPathIdentityKey").and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                && canonical.get("candidateDirectoryPathIdentityKey")
                    == canonical.get("sourceDirectoryPathIdentityKey")
                && canonical.get("candidateTerminalCommitState").and_then(Value::as_str)
                    == Some("POST_PUBLISH_READBACK_CONFIRMED")
                && canonical.get("candidateDirectoryAgreement").and_then(Value::as_bool)
                    == Some(true)
                && canonical.get("sourceFreshnessPreserved").and_then(Value::as_bool)
                    == Some(true)
                && canonical.get("sourceFreshnessTokenBefore").and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                && canonical.get("sourceFreshnessTokenBefore")
                    == canonical.get("sourceFreshnessTokenAfter")
                && binding_identity_is_exact
                && binding_before == binding_after
                && canonical.get("bindingPreserved").and_then(Value::as_bool) == Some(true)
                && literature_sibling_is_exact
                && canonical.get("literatureSiblingBindingPreserved").and_then(Value::as_bool)
                    == Some(true)
                && canonical.get("currentChanged").and_then(Value::as_bool) == Some(false)
                && canonical.get("defaultChanged").and_then(Value::as_bool) == Some(false)
                && canonical.get("formalSwitchInvoked").and_then(Value::as_bool) == Some(false)
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == current.confirmed_payload_fingerprint.as_deref()
                && canonical.get("confirmedBodyFingerprint").and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                && canonical.get("confirmedBodyFingerprint")
                    == canonical.get("physicalBodyFingerprint")
                && canonical.get("physicalEncoding").and_then(Value::as_str) == Some("utf-8")
                && canonical.get("physicalSizeBytes").and_then(Value::as_u64)
                    .is_some_and(|value| value > 0)
                && canonical.get("readbackState").and_then(Value::as_str)
                    == Some("CANDIDATE_FILE_REF_PHYSICAL_BODY_SOURCE_AND_BINDING_PRESERVED")
        }
        (
            "experimentRun",
            "fileRef",
            "NEW_MANUSCRIPT",
            "experimentRunManuscriptSaveAsAdapter.saveAs",
        ) => {
            let expected_operation_id = format!(
                "a14-run-man:{}:{}",
                current.id, input.authorization_id
            );
            let operation_generation = canonical
                .get("operationGeneration")
                .and_then(Value::as_u64);
            let expected_candidate_request_id = operation_generation
                .filter(|generation| *generation > 0)
                .map(|generation| format!("{expected_operation_id}:{generation}"));
            let confirmed_body_fingerprint = canonical
                .get("confirmedBodyFingerprint")
                .and_then(Value::as_str);
            let preservation_source_file_ref_id = canonical
                .get("preservationOperationSourceFileRefId")
                .and_then(Value::as_str);
            let previous_current_file_ref_id = canonical
                .get("previousCurrentFileRefId")
                .and_then(Value::as_str);
            let binding_readback = canonical
                .get("bindingReadback")
                .and_then(Value::as_object);
            let binding_current_file_ref_id = binding_readback
                .and_then(|binding| binding.get("currentFileRefId"))
                .and_then(Value::as_str);
            let binding_default_file_ref_id = binding_readback
                .and_then(|binding| binding.get("defaultManuscriptFileRefId"))
                .and_then(Value::as_str);
            let is_bounded_fingerprint = |value: Option<&str>| {
                value
                    .and_then(|candidate| candidate.strip_prefix("lp13-a6-"))
                    .is_some_and(|suffix| {
                        suffix.len() == 8
                            && suffix.chars().all(|character| character.is_ascii_hexdigit())
                    })
            };
            target_module == "experimentRun"
                && target_entity_type == "experimentRun"
                && target_entity_id == canonical.get("runId").and_then(Value::as_str)
                && current.target.get("parentExperimentId").and_then(Value::as_str)
                    == canonical.get("parentExperimentId").and_then(Value::as_str)
                && current.target.get("manuscriptChannel").and_then(Value::as_str)
                    == Some("primary")
                && canonical.get("manuscriptChannel").and_then(Value::as_str)
                    == Some("primary")
                && canonical.get("resultId").and_then(Value::as_str)
                    == Some(current.id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(input.authorization_id.as_str())
                && is_bounded_fingerprint(
                    canonical.get("authorizationFingerprint").and_then(Value::as_str)
                )
                && canonical.get("operationId").and_then(Value::as_str)
                    == Some(expected_operation_id.as_str())
                && canonical.get("fileRefId").and_then(Value::as_str)
                    == Some(receipt_entity_id)
                && canonical.get("artifactAssociation").and_then(Value::as_str)
                    == Some("INDEPENDENT_MANAGED_MANUSCRIPT")
                && is_bounded_fingerprint(
                    canonical.get("targetIdentityDigest").and_then(Value::as_str)
                )
                && canonical.get("resourceKind").and_then(Value::as_str) == Some("file")
                && canonical.get("fileRole").and_then(Value::as_str) == Some("manuscript")
                && canonical.get("targetLocationMode").and_then(Value::as_str)
                    == Some("managed")
                && canonical.get("operationStage").and_then(Value::as_str)
                    == Some("completed")
                && canonical.get("d1CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("d2CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == current.confirmed_payload_fingerprint.as_deref()
                && confirmed_body_fingerprint.is_some_and(|value| !value.is_empty())
                && canonical.get("latestVisibleSourceBodyFingerprint").and_then(Value::as_str)
                    == confirmed_body_fingerprint
                && confirmed_body_fingerprint
                    == canonical.get("physicalBodyFingerprint").and_then(Value::as_str)
                && canonical.get("physicalEncoding").and_then(Value::as_str) == Some("utf-8")
                && canonical.get("physicalSizeBytes").and_then(Value::as_u64)
                    .is_some_and(|value| value > 0)
                && canonical.get("bodyNormalization").and_then(Value::as_str)
                    == Some("CRLF_TO_LF")
                && canonical.get("documentLineEnding").and_then(Value::as_str) == Some("LF")
                && canonical.get("documentTerminalNewline").and_then(Value::as_str)
                    == Some("one LF for the complete LabPod Markdown document")
                && canonical.get("preservationProofMode").and_then(Value::as_str)
                    == Some("CANONICAL_OPERATION_CONTRACT_NO_BINDING_WRITE_PLUS_EXACT_OPERATION_READBACK")
                && preservation_source_file_ref_id.is_some_and(|value| !value.is_empty())
                && preservation_source_file_ref_id == previous_current_file_ref_id
                && previous_current_file_ref_id == binding_current_file_ref_id
                && previous_current_file_ref_id != Some(receipt_entity_id)
                && binding_default_file_ref_id.is_some_and(|value| !value.is_empty())
                && binding_default_file_ref_id != Some(receipt_entity_id)
                && binding_readback
                    .and_then(|binding| binding.get("id"))
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
                && binding_readback
                    .and_then(|binding| binding.get("ownerType"))
                    .and_then(Value::as_str)
                    == Some("experimentRun")
                && binding_readback
                    .and_then(|binding| binding.get("ownerId"))
                    .and_then(Value::as_str)
                    == canonical.get("runId").and_then(Value::as_str)
                && binding_readback
                    .and_then(|binding| binding.get("manuscriptChannel"))
                    .and_then(Value::as_str)
                    == Some("primary")
                && canonical.get("previousCurrentBodyFingerprint").and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
                && matches!(
                    canonical.get("preEffectBaselineSource").and_then(Value::as_str),
                    Some("CONFIRM_TIME_RUNTIME_BASELINE")
                        | Some("CANONICAL_NO_BINDING_WRITE_OPERATION_PROOF")
                )
                && canonical.get("firstProvisioningDisposition").and_then(Value::as_str)
                    == Some("NOT_APPLICABLE_WITH_CURRENT_RUN_CREATION_CONTRACT")
                && canonical.get("bindingPreserved").and_then(Value::as_bool) == Some(true)
                && canonical.get("currentChanged").and_then(Value::as_bool) == Some(false)
                && canonical.get("defaultChanged").and_then(Value::as_bool) == Some(false)
                && canonical.get("formalSwitchInvoked").and_then(Value::as_bool) == Some(false)
                && canonical.get("candidateRequestId").and_then(Value::as_str)
                    == expected_candidate_request_id.as_deref()
                && canonical.get("candidateOccurredAt").and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty() && value.len() <= 80)
                && canonical.get("readbackState").and_then(Value::as_str)
                    == Some("AUTHORITATIVE_RUN_FILE_REF_LIST_PHYSICAL_BODY_BINDING_PRESERVED")
        }
        (
            "literature",
            "fileRef",
            "NEW_MANUSCRIPT",
            "literatureManuscriptSaveAsAdapter.saveAs",
        ) => {
            let exact_channel = current
                .target
                .get("manuscriptChannel")
                .and_then(Value::as_str);
            let expected_operation_id = match exact_channel {
                Some("literature_outline") => Some(format!(
                    "a17-lit-outline-man:{}:{}",
                    current.id, input.authorization_id
                )),
                Some("dedicated_notes") => Some(format!(
                    "a18-lit-notes-man:{}:{}",
                    current.id, input.authorization_id
                )),
                _ => None,
            };
            let operation_generation = canonical
                .get("operationGeneration")
                .and_then(Value::as_u64);
            let expected_candidate_request_id = expected_operation_id
                .as_deref()
                .zip(operation_generation)
                .filter(|(_, generation)| *generation > 0)
                .map(|(operation_id, generation)| format!("{operation_id}:{generation}"));
            let expected_readback_state = match exact_channel {
                Some("literature_outline") => Some(
                    "AUTHORITATIVE_LITERATURE_OUTLINE_FILE_REF_LIST_PHYSICAL_BODY_DUAL_CHANNEL_BINDING_PRESERVED",
                ),
                Some("dedicated_notes") => Some(
                    "AUTHORITATIVE_LITERATURE_DEDICATED_NOTES_FILE_REF_LIST_PHYSICAL_BODY_DUAL_CHANNEL_BINDING_PRESERVED",
                ),
                _ => None,
            };
            let confirmed_body_fingerprint = canonical
                .get("confirmedBodyFingerprint")
                .and_then(Value::as_str);
            let preservation_source_file_ref_id = canonical
                .get("preservationOperationSourceFileRefId")
                .and_then(Value::as_str);
            let previous_outline_current_file_ref_id = canonical
                .get("previousOutlineCurrentFileRefId")
                .and_then(Value::as_str);
            let previous_notes_current_file_ref_id = canonical
                .get("previousDedicatedNotesCurrentFileRefId")
                .and_then(Value::as_str);
            let outline_binding = canonical
                .get("outlineBindingReadback")
                .and_then(Value::as_object);
            let notes_binding = canonical
                .get("dedicatedNotesBindingReadback")
                .and_then(Value::as_object);
            let outline_current_file_ref_id = outline_binding
                .and_then(|binding| binding.get("currentFileRefId"))
                .and_then(Value::as_str);
            let outline_default_file_ref_id = outline_binding
                .and_then(|binding| binding.get("defaultManuscriptFileRefId"))
                .and_then(Value::as_str);
            let notes_current_file_ref_id = notes_binding
                .and_then(|binding| binding.get("currentFileRefId"))
                .and_then(Value::as_str);
            let notes_default_file_ref_id = notes_binding
                .and_then(|binding| binding.get("defaultManuscriptFileRefId"))
                .and_then(Value::as_str);
            let is_bounded_fingerprint = |value: Option<&str>| {
                value
                    .and_then(|candidate| candidate.strip_prefix("lp13-a6-"))
                    .is_some_and(|suffix| {
                        suffix.len() == 8
                            && suffix.chars().all(|character| character.is_ascii_hexdigit())
                    })
            };
            target_module == "literature"
                && target_entity_type == "literature"
                && target_entity_id == canonical.get("literatureId").and_then(Value::as_str)
                && current.target.get("primaryProjectId")
                    == canonical.get("primaryProjectId")
                && matches!(exact_channel, Some("literature_outline") | Some("dedicated_notes"))
                && canonical.get("manuscriptChannel").and_then(Value::as_str) == exact_channel
                && canonical.get("resultId").and_then(Value::as_str)
                    == Some(current.id.as_str())
                && canonical.get("authorizationId").and_then(Value::as_str)
                    == Some(input.authorization_id.as_str())
                && is_bounded_fingerprint(
                    canonical.get("authorizationFingerprint").and_then(Value::as_str)
                )
                && canonical.get("operationId").and_then(Value::as_str)
                    == expected_operation_id.as_deref()
                && operation_generation.is_some_and(|value| value > 0)
                && canonical.get("candidateRequestId").and_then(Value::as_str)
                    == expected_candidate_request_id.as_deref()
                && canonical.get("candidateOccurredAt").and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty() && value.len() <= 80)
                && canonical.get("fileRefId").and_then(Value::as_str)
                    == Some(receipt_entity_id)
                && canonical.get("artifactAssociation").and_then(Value::as_str)
                    == Some("INDEPENDENT_MANAGED_MANUSCRIPT")
                && is_bounded_fingerprint(
                    canonical.get("targetIdentityDigest").and_then(Value::as_str)
                )
                && canonical.get("resourceKind").and_then(Value::as_str) == Some("file")
                && canonical.get("fileRole").and_then(Value::as_str) == Some("manuscript")
                && canonical.get("targetLocationMode").and_then(Value::as_str)
                    == Some("managed")
                && canonical.get("operationStage").and_then(Value::as_str)
                    == Some("completed")
                && canonical.get("d1CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("d2CommitState").and_then(Value::as_str)
                    == Some("confirmed")
                && canonical.get("confirmedPayloadFingerprint").and_then(Value::as_str)
                    == current.confirmed_payload_fingerprint.as_deref()
                && confirmed_body_fingerprint.is_some_and(|value| !value.is_empty())
                && canonical.get("latestVisibleSourceBodyFingerprint").and_then(Value::as_str)
                    == confirmed_body_fingerprint
                && confirmed_body_fingerprint
                    == canonical.get("physicalBodyFingerprint").and_then(Value::as_str)
                && canonical.get("physicalEncoding").and_then(Value::as_str) == Some("utf-8")
                && canonical.get("physicalSizeBytes").and_then(Value::as_u64)
                    .is_some_and(|value| value > 0)
                && canonical.get("bodyNormalization").and_then(Value::as_str)
                    == Some("CRLF_TO_LF")
                && canonical.get("documentLineEnding").and_then(Value::as_str) == Some("LF")
                && canonical.get("documentTerminalNewline").and_then(Value::as_str)
                    == Some("one LF for the complete LabPod Markdown document")
                && canonical.get("preservationProofMode").and_then(Value::as_str)
                    == Some("CANONICAL_OPERATION_CONTRACT_NO_BINDING_WRITE_PLUS_DUAL_CHANNEL_EXACT_READBACK")
                && preservation_source_file_ref_id.is_some_and(|value| !value.is_empty())
                && preservation_source_file_ref_id == match exact_channel {
                    Some("literature_outline") => previous_outline_current_file_ref_id,
                    Some("dedicated_notes") => previous_notes_current_file_ref_id,
                    _ => None,
                }
                && previous_outline_current_file_ref_id == outline_current_file_ref_id
                && previous_outline_current_file_ref_id.is_some_and(|value| !value.is_empty())
                && previous_outline_current_file_ref_id != Some(receipt_entity_id)
                && outline_default_file_ref_id.is_some_and(|value| !value.is_empty())
                && outline_default_file_ref_id != Some(receipt_entity_id)
                && previous_notes_current_file_ref_id == notes_current_file_ref_id
                && previous_notes_current_file_ref_id.is_some_and(|value| !value.is_empty())
                && notes_default_file_ref_id.is_some_and(|value| !value.is_empty())
                && notes_default_file_ref_id != Some(receipt_entity_id)
                && outline_binding
                    .and_then(|binding| binding.get("ownerType"))
                    .and_then(Value::as_str) == Some("literature")
                && outline_binding
                    .and_then(|binding| binding.get("ownerId"))
                    .and_then(Value::as_str) == canonical.get("literatureId").and_then(Value::as_str)
                && outline_binding
                    .and_then(|binding| binding.get("manuscriptChannel"))
                    .and_then(Value::as_str) == Some("literature_outline")
                && notes_binding
                    .and_then(|binding| binding.get("ownerType"))
                    .and_then(Value::as_str) == Some("literature")
                && notes_binding
                    .and_then(|binding| binding.get("ownerId"))
                    .and_then(Value::as_str) == canonical.get("literatureId").and_then(Value::as_str)
                && notes_binding
                    .and_then(|binding| binding.get("manuscriptChannel"))
                    .and_then(Value::as_str) == Some("dedicated_notes")
                && canonical.get("previousOutlineCurrentBodyFingerprint").and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
                && canonical.get("previousDedicatedNotesCurrentBodyFingerprint").and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
                && canonical.get("outlineManuscriptCount").and_then(Value::as_u64)
                    .is_some_and(|value| value >= if exact_channel == Some("literature_outline") { 2 } else { 1 })
                && canonical.get("dedicatedNotesManuscriptCount").and_then(Value::as_u64)
                    .is_some_and(|value| value >= if exact_channel == Some("dedicated_notes") { 2 } else { 1 })
                && matches!(
                    canonical.get("preEffectBaselineSource").and_then(Value::as_str),
                    Some("CONFIRM_TIME_DUAL_CHANNEL_BASELINE")
                        | Some("CANONICAL_NO_BINDING_WRITE_OPERATION_PROOF")
                )
                && canonical.get("firstProvisioningDisposition").and_then(Value::as_str)
                    == Some("NOT_APPLICABLE_WITH_CURRENT_CONTRACT")
                && canonical.get("outlineBindingPreserved").and_then(Value::as_bool) == Some(true)
                && canonical.get("dedicatedNotesPreserved").and_then(Value::as_bool) == Some(true)
                && canonical.get("currentChanged").and_then(Value::as_bool) == Some(false)
                && canonical.get("defaultChanged").and_then(Value::as_bool) == Some(false)
                && canonical.get("formalSwitchInvoked").and_then(Value::as_bool) == Some(false)
                && canonical.get("body").is_none()
                && canonical.get("targetPath").is_none()
                && canonical.get("readbackState").and_then(Value::as_str)
                    == expected_readback_state
        }
        _ => false,
    };
    let parent_settlement_matches = lp14_a1_c4_parent_settlement_matches(
        &current,
        &input.authorization_id,
        &input.effect_receipt,
    );
    if receipt_operation != current.action.as_str()
        || receipt_project_id != Some(target_project_id)
        || !receipt_matches_target
        || !parent_settlement_matches
    {
        return Err(fail(
            "AI_STANDARD_RESULT_EFFECT_INVALID",
            "The effect receipt does not match the durable Standard Result target and action",
        ));
    }
    if current.disposition == "CONFIRMED"
        && current.authorization_id.as_deref() == Some(&input.authorization_id)
        && current.effect_receipt.as_ref() == Some(&input.effect_receipt)
        && current.decided_at.as_deref() == Some(&input.settled_at)
    {
        transaction
            .commit()
            .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
        return read_ai_conversation_in_connection(connection, &input.conversation_id);
    }
    if current.disposition != "PENDING"
        || current.authorization_id.as_deref() != Some(&input.authorization_id)
        || current.confirmed_payload.is_none()
    {
        return Err(fail(
            "AI_STANDARD_RESULT_CONFIRMATION_CONFLICT",
            "The Standard Result effect has no matching durable confirmation authorization",
        ));
    }
    let updated = transaction
        .execute(
            "UPDATE ai_standard_results SET disposition='CONFIRMED',decided_at=?1,
               effect_receipt_json=?2,updated_at=?1
             WHERE id=?3 AND conversation_id=?4 AND disposition='PENDING' AND authorization_id=?5",
            params![
                input.settled_at,
                receipt_json,
                input.result_id,
                input.conversation_id,
                input.authorization_id,
            ],
        )
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    if updated != 1 {
        return Err(fail(
            "AI_STANDARD_RESULT_CONFIRMATION_CONFLICT",
            "The Standard Result changed before effect correlation could commit",
        ));
    }
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.settled_at, input.conversation_id],
        )
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    transaction
        .commit()
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    read_ai_conversation_in_connection(connection, &input.conversation_id)
}

pub(crate) fn fail_ai_standard_result_in_connection(
    connection: &mut Connection,
    input: &FailAIStandardResultInput,
) -> Result<AIConversationReadback, String> {
    for (value, field, max) in [
        (&input.conversation_id, "conversationId", 200),
        (&input.result_id, "resultId", 200),
        (&input.failure_code, "failureCode", 120),
        (&input.failure_message, "failureMessage", 600),
        (&input.failed_at, "failedAt", 80),
    ] {
        require_text(value, field, max)?;
    }
    if !matches!(input.disposition.as_str(), "STALE" | "FAILED") {
        return Err(fail(
            "AI_STANDARD_RESULT_INVALID",
            "Only STALE or FAILED may terminate a failed Standard Result",
        ));
    }
    if let Some(authorization_id) = &input.authorization_id {
        require_text(authorization_id, "authorizationId", 200)?;
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    let current = standard_result_for_conversation(
        &transaction,
        &input.conversation_id,
        &input.result_id,
    )?;
    if current.disposition == input.disposition
        && current.authorization_id == input.authorization_id
        && current.failure_code.as_deref() == Some(&input.failure_code)
        && current.failure_message.as_deref() == Some(&input.failure_message)
        && current.decided_at.as_deref() == Some(&input.failed_at)
    {
        transaction
            .commit()
            .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
        return read_ai_conversation_in_connection(connection, &input.conversation_id);
    }
    if current.disposition != "PENDING"
        || current.authorization_id.as_deref() != input.authorization_id.as_deref()
    {
        return Err(fail(
            "AI_STANDARD_RESULT_TERMINAL_CONFLICT",
            "The Standard Result cannot be failed with this authorization identity",
        ));
    }
    let updated = transaction
        .execute(
            "UPDATE ai_standard_results SET disposition=?1,decided_at=?2,failure_code=?3,
               failure_message=?4,updated_at=?2
             WHERE id=?5 AND conversation_id=?6 AND disposition='PENDING' AND
               authorization_id IS ?7",
            params![
                input.disposition,
                input.failed_at,
                input.failure_code,
                input.failure_message,
                input.result_id,
                input.conversation_id,
                input.authorization_id,
            ],
        )
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    if updated != 1 {
        return Err(fail(
            "AI_STANDARD_RESULT_TERMINAL_CONFLICT",
            "The Standard Result changed before failure correlation could commit",
        ));
    }
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.failed_at, input.conversation_id],
        )
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    transaction
        .commit()
        .map_err(|error| fail("AI_STANDARD_RESULT_WRITE_FAILED", error.to_string()))?;
    read_ai_conversation_in_connection(connection, &input.conversation_id)
}

fn usage_tuple(usage: &Option<AIUsageInput>) -> (Option<i64>, Option<i64>, Option<i64>) {
    usage
        .as_ref()
        .map(|usage| (usage.input_tokens, usage.output_tokens, usage.total_tokens))
        .unwrap_or((None, None, None))
}

fn validate_usage(usage: &Option<AIUsageInput>) -> Result<(), String> {
    let (input, output, total) = usage_tuple(usage);
    if [input, output, total]
        .into_iter()
        .flatten()
        .any(|value| value < 0)
    {
        return Err(fail(
            "AI_DURABLE_INPUT_INVALID",
            "usage tokens cannot be negative",
        ));
    }
    Ok(())
}

fn insert_context_request(
    connection: &Connection,
    conversation_id: &str,
    source_message_id: &str,
    source_call_attempt_id: &str,
    input: &NewAIContextRequestInput,
) -> Result<(), String> {
    validate_context_request_input(input)?;
    let source_json = json_text(&input.source, "contextRequest.source")?;
    let requested_refs_json = json_text(&input.requested_refs, "contextRequest.requestedRefs")?;
    let reviewed_candidates_json = json_text(
        &input.reviewed_candidates,
        "contextRequest.reviewedCandidates",
    )?;
    let stale = input.initial_state == "STALE_OR_INVALID";
    connection
        .execute(
            "INSERT INTO ai_context_requests(
               id,conversation_id,source_message_id,source_call_attempt_id,
               source_snapshot_json,reason,requested_refs_json,reviewed_candidates_json,state,
               decision_action_message_id,decision_type,decision_at,decision_reason,
               approved_refs_json,followup_call_attempt_id,created_at
             ) VALUES (
               ?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,
               CASE WHEN ?10 THEN 'STALE' ELSE NULL END,
               CASE WHEN ?10 THEN ?11 ELSE NULL END,
               CASE WHEN ?10 THEN ?12 ELSE NULL END,
               NULL,NULL,?11
             )",
            params![
                input.id,
                conversation_id,
                source_message_id,
                source_call_attempt_id,
                source_json,
                input.reason,
                requested_refs_json,
                reviewed_candidates_json,
                input.initial_state,
                stale,
                input.created_at,
                input.invalid_reason,
            ],
        )
        .map_err(|error| {
            fail(
                "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
    Ok(())
}

fn assert_idempotent_context_request(
    connection: &Connection,
    existing: &AICallAttemptRecord,
    input: &SettleAICallAttemptSuccessInput,
) -> Result<(), String> {
    let durable: Option<(String, String, String, String, String, String, String, Option<String>)> =
        connection
            .query_row(
                "SELECT id,source_message_id,source_snapshot_json,reason,requested_refs_json,
                        reviewed_candidates_json,state,decision_reason
                 FROM ai_context_requests WHERE source_call_attempt_id=?1",
                [&existing.id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    let Some(proposed) = input.context_request.as_ref() else {
        return if durable.is_none() {
            Ok(())
        } else {
            Err(fail(
                "AI_DURABLE_TERMINAL_CONFLICT",
                "CallAttempt Context Request cannot be removed on replay",
            ))
        };
    };
    validate_context_request_input(proposed)?;
    let expected_source_message_id = input
        .assistant_message
        .as_ref()
        .map(|message| message.id.as_str())
        .unwrap_or("");
    let Some((
        id,
        source_message_id,
        source_json,
        reason,
        requested_json,
        reviewed_json,
        state,
        decision_reason,
    )) = durable
    else {
        return Err(fail(
            "AI_DURABLE_TERMINAL_CONFLICT",
            "CallAttempt Context Request is missing on replay",
        ));
    };
    if id != proposed.id
        || source_message_id != expected_source_message_id
        || parse_json(source_json, "context_request_source")? != proposed.source
        || reason != proposed.reason
        || parse_json(requested_json, "context_request_requested_refs")?
            != proposed.requested_refs
        || parse_json(reviewed_json, "context_request_reviewed_candidates")?
            != proposed.reviewed_candidates
        || (proposed.initial_state == "STALE_OR_INVALID"
            && (state != "STALE_OR_INVALID" || decision_reason != proposed.invalid_reason))
        || (proposed.initial_state == "PENDING"
            && !matches!(
                state.as_str(),
                "PENDING" | "APPROVED" | "REJECTED" | "STALE_OR_INVALID"
            ))
    {
        return Err(fail(
            "AI_DURABLE_TERMINAL_CONFLICT",
            "CallAttempt Context Request cannot be overwritten",
        ));
    }
    Ok(())
}

fn required_json_text_field<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| {
            fail(
                "AI_STANDARD_RESULT_INVALID",
                format!("Standard Result {field} is required"),
            )
        })
}

fn exact_outputs_frozen_target_matches(
    existing: &AICallAttemptRecord,
    result: &NewAIStandardResultInput,
) -> bool {
    if !matches!(result.action.as_str(), "UPDATE" | "DELETE_SUGGESTION") {
        return true;
    }
    let Some(target_module) = result.target.get("module").and_then(Value::as_str) else {
        return false;
    };
    let source_module = match target_module {
        "finding" | "resultItem" | "outputCandidate" | "outputGap" => "outputConversion",
        "researchOutput" => "output",
        _ => return true,
    };
    let Some(target_entity_id) = result.target.get("entityId").and_then(Value::as_str) else {
        return false;
    };
    let Some(source_refs) = existing.context_source_refs.as_array() else {
        return false;
    };
    let frozen_target_ids = source_refs
        .iter()
        .filter(|source_ref| {
            source_ref.get("contextDisposition").and_then(Value::as_str) == Some("included")
                && source_ref.get("contextRole").and_then(Value::as_str) == Some("primary")
                && source_ref.get("module").and_then(Value::as_str) == Some(source_module)
                && source_ref.get("entityType").and_then(Value::as_str) == Some(target_module)
                && source_ref.get("isVerified").and_then(Value::as_bool) == Some(true)
        })
        .filter_map(|source_ref| source_ref.get("entityId").and_then(Value::as_str))
        .filter(|entity_id| !entity_id.trim().is_empty() && entity_id.len() <= 200)
        .collect::<BTreeSet<_>>();
    frozen_target_ids.len() == 1 && frozen_target_ids.contains(target_entity_id)
}

fn exact_route_frozen_target_matches(
    existing: &AICallAttemptRecord,
    result: &NewAIStandardResultInput,
) -> bool {
    if result.target.get("module").and_then(Value::as_str) != Some("route")
        || !matches!(result.action.as_str(), "UPDATE" | "DELETE_SUGGESTION")
    {
        return true;
    }
    if result.target.get("entityType").and_then(Value::as_str) != Some("routeNode") {
        return false;
    }
    let Some(target_entity_id) = result
        .target
        .get("entityId")
        .and_then(Value::as_str)
        .filter(|entity_id| !entity_id.trim().is_empty() && entity_id.len() <= 200)
    else {
        return false;
    };
    let Some(target_project_id) = result
        .target
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|project_id| !project_id.trim().is_empty() && project_id.len() <= 200)
    else {
        return false;
    };
    if !result
        .source
        .get("selectedRouteIds")
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.len() == 1 && ids[0].as_str() == Some(target_entity_id))
    {
        return false;
    }
    let Some(source_refs) = existing.context_source_refs.as_array() else {
        return false;
    };
    let frozen_target_refs = source_refs
        .iter()
        .filter(|source_ref| {
            source_ref.get("contextDisposition").and_then(Value::as_str) == Some("included")
                && source_ref.get("contextRole").and_then(Value::as_str) == Some("primary")
                && source_ref.get("module").and_then(Value::as_str) == Some("route")
                && source_ref.get("entityType").and_then(Value::as_str) == Some("routeNode")
                && source_ref.get("isVerified").and_then(Value::as_bool) == Some(true)
        })
        .collect::<Vec<_>>();
    if frozen_target_refs.len() != 1
        || frozen_target_refs[0].get("entityId").and_then(Value::as_str)
            != Some(target_entity_id)
    {
        return false;
    }
    let frozen_project_ids = source_refs
        .iter()
        .filter(|source_ref| {
            source_ref.get("contextDisposition").and_then(Value::as_str) == Some("included")
                && source_ref.get("contextRole").and_then(Value::as_str) == Some("scope")
                && source_ref.get("module").and_then(Value::as_str) == Some("project")
                && source_ref.get("entityType").and_then(Value::as_str) == Some("project")
        })
        .filter_map(|source_ref| source_ref.get("entityId").and_then(Value::as_str))
        .filter(|project_id| !project_id.trim().is_empty() && project_id.len() <= 200)
        .collect::<BTreeSet<_>>();
    if frozen_project_ids.len() != 1 || !frozen_project_ids.contains(target_project_id) {
        return false;
    }
    let discussion_scope_refs = source_refs
        .iter()
        .filter(|source_ref| {
            source_ref.get("module").and_then(Value::as_str) == Some("ai")
            && source_ref.get("entityType").and_then(Value::as_str) == Some("system")
            && source_ref.get("field").and_then(Value::as_str)
                == Some("relevantEffectiveDiscussion")
        })
        .collect::<Vec<_>>();
    discussion_scope_refs.len() == 1
        && discussion_scope_refs[0]
            .get("parseProjectId")
            .and_then(Value::as_str)
            == Some(target_project_id)
        && discussion_scope_refs[0]
            .get("parseRouteIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.len() == 1 && ids[0].as_str() == Some(target_entity_id))
        && discussion_scope_refs[0]
            .get("parseContextMode")
            .and_then(Value::as_str)
            == result.source.get("contextMode").and_then(Value::as_str)
        && discussion_scope_refs[0]
            .get("parseContextReviewFingerprint")
            .and_then(Value::as_str)
            == result
                .source
                .get("contextReviewFingerprint")
                .and_then(Value::as_str)
        && discussion_scope_refs[0]
            .get("parseDiscussionFingerprint")
            .and_then(Value::as_str)
            == result
                .source
                .get("discussionFingerprint")
                .and_then(Value::as_str)
}

fn validate_standard_result_batch(
    existing: &AICallAttemptRecord,
    input: &NewAIStandardResultBatchInput,
) -> Result<(), String> {
    require_text(&input.id, "standardResultBatch.id", 200)?;
    require_text(&input.created_at, "standardResultBatch.createdAt", 80)?;
    if input.results.is_empty() || input.results.len() > 8 {
        return Err(fail(
            "AI_STANDARD_RESULT_INVALID",
            "A Standard Result batch must contain between one and eight results",
        ));
    }
    let mut ids = BTreeSet::new();
    for (index, result) in input.results.iter().enumerate() {
        require_text(&result.id, "standardResult.id", 200)?;
        require_text(
            &result.visible_payload_fingerprint,
            "standardResult.visiblePayloadFingerprint",
            200,
        )?;
        if result.ordinal != index as i64 + 1 || !ids.insert(result.id.as_str()) {
            return Err(fail(
                "AI_STANDARD_RESULT_INVALID",
                "Standard Result identities and ordinals must be unique and contiguous",
            ));
        }
        let valid_pair = matches!(
            (result.category.as_str(), result.action.as_str()),
            ("DATA_OPERATION", "CREATE" | "UPDATE" | "DELETE_SUGGESTION")
                | ("MANUSCRIPT_RESULT", "NEW_MANUSCRIPT")
        );
        if !valid_pair {
            return Err(fail(
                "AI_STANDARD_RESULT_INVALID",
                "Standard Result category/action pair is outside the shared contract",
            ));
        }
        let target_module = required_json_text_field(&result.target, "module")?;
        let target_entity_type = required_json_text_field(&result.target, "entityType")?;
        let target_project_id = required_json_text_field(&result.target, "projectId")?;
        let requires_existing_target = matches!(
            result.action.as_str(),
            "UPDATE" | "DELETE_SUGGESTION" | "NEW_MANUSCRIPT"
        );
        let target_entity_id_valid = !requires_existing_target
            || required_json_text_field(&result.target, "entityId")?.len() <= 200;
        let target_key_count = result.target.as_object().map_or(0, |target| target.len());
        let target_shape_valid = match (target_module, target_entity_type) {
            ("route", "routeNode") => {
                result.target.get("manuscriptChannel").is_none()
                    && if result.action == "CREATE" {
                        result.target.get("entityId").is_none() && target_key_count == 3
                    } else if matches!(result.action.as_str(), "UPDATE" | "DELETE_SUGGESTION") {
                        target_entity_id_valid && target_key_count == 4
                    } else {
                        false
                    }
            }
            ("task", "task") => {
                target_entity_id_valid
                    && result.target.get("manuscriptChannel").is_none()
                    && if result.action == "CREATE" {
                        result.target.get("entityId").is_none() && target_key_count == 3
                    } else {
                        target_key_count == 4
                    }
            }
            (
                "finding" | "resultItem" | "outputCandidate" | "outputGap"
                    | "researchOutput",
                entity_type,
            ) => {
                target_module == entity_type
                    && if result.action == "NEW_MANUSCRIPT" {
                        target_entity_id_valid
                            && result.target.get("manuscriptChannel").and_then(Value::as_str)
                                == Some("primary")
                            && target_key_count == 5
                    } else if result.action == "CREATE" {
                        result.target.get("entityId").is_none()
                            && result.target.get("manuscriptChannel").is_none()
                            && target_key_count == 3
                    } else {
                        target_entity_id_valid
                            && result.target.get("manuscriptChannel").is_none()
                            && target_key_count == 4
                    }
            }
            ("review", "review") => {
                target_entity_id_valid
                    && if result.action == "NEW_MANUSCRIPT" {
                        required_json_text_field(&result.target, "manuscriptChannel")?.len() <= 200
                    } else {
                        result.target.get("manuscriptChannel").is_none()
                    }
                    && if result.action == "CREATE" {
                        result.target.get("entityId").is_none() && target_key_count == 3
                    } else if result.action == "NEW_MANUSCRIPT" {
                        target_key_count == 5
                    } else {
                        target_key_count == 4
                    }
            }
            ("experiment", "experiment") => {
                target_entity_id_valid
                    && if result.action == "NEW_MANUSCRIPT" {
                        result.target.get("manuscriptChannel").and_then(Value::as_str)
                            == Some("primary")
                    } else {
                        result.target.get("manuscriptChannel").is_none()
                    }
                    && if result.action == "CREATE" {
                        result.target.get("entityId").is_none() && target_key_count == 3
                    } else if result.action == "NEW_MANUSCRIPT" {
                        target_key_count == 5
                    } else {
                        target_key_count == 4
                    }
            }
            ("experimentRun", "experimentRun") => {
                let canonical_quick_target = result.action == "NEW_MANUSCRIPT"
                    && result.source.get("quickAnalysisTarget").is_some_and(Value::is_object);
                if canonical_quick_target {
                    target_entity_id_valid
                        && result.target.get("manuscriptChannel").and_then(Value::as_str)
                            == Some("primary")
                        && target_key_count == 5
                } else {
                let has_validation_issues = result
                    .validation_issues
                    .as_array()
                    .is_some_and(|issues| !issues.is_empty());
                let unresolved_invalid_shape = has_validation_issues
                    && result.target.get("parentExperimentId").is_none()
                    && result.target.get("parentExperimentLabel").is_none()
                    && result.target.get("projectLabel").is_none()
                    && result.target.get("expectedUpdatedAt").is_none()
                    && if result.action == "CREATE" {
                        result.target.get("entityId").is_none() && target_key_count == 3
                    } else {
                        target_entity_id_valid && target_key_count == 4
                    };
                if unresolved_invalid_shape {
                    true
                } else {
                let parent_valid = required_json_text_field(
                    &result.target,
                    "parentExperimentId",
                )?
                .len()
                    <= 200;
                let labels_valid = required_json_text_field(
                    &result.target,
                    "parentExperimentLabel",
                )?
                .len()
                    <= 300
                    && required_json_text_field(&result.target, "projectLabel")?.len() <= 300;
                target_entity_id_valid
                    && parent_valid
                    && labels_valid
                    && if result.action == "NEW_MANUSCRIPT" {
                        result.target.get("manuscriptChannel").and_then(Value::as_str)
                            == Some("primary")
                    } else {
                        result.target.get("manuscriptChannel").is_none()
                    }
                    && if result.action == "CREATE" {
                        result.target.get("entityId").is_none()
                            && result.target.get("expectedUpdatedAt").is_none()
                            && target_key_count == 6
                    } else if result.action == "UPDATE" {
                        required_json_text_field(&result.target, "expectedUpdatedAt")?.len() <= 80
                            && target_key_count == 8
                    } else if result.action == "NEW_MANUSCRIPT" {
                        result.target.get("expectedUpdatedAt").is_none()
                            && target_key_count == 8
                    } else {
                        result.target.get("expectedUpdatedAt").is_none()
                            && target_key_count == 7
                    }
                }
                }
            }
            ("literature", "literature") => {
                let canonical_quick_target = result.action == "NEW_MANUSCRIPT"
                    && result.source.get("quickAnalysisTarget").is_some_and(Value::is_object);
                if canonical_quick_target {
                    target_entity_id_valid
                        && matches!(
                            result.target.get("manuscriptChannel").and_then(Value::as_str),
                            Some("literature_outline") | Some("dedicated_notes")
                        )
                        && target_key_count == 5
                } else {
                let has_validation_issues = result
                    .validation_issues
                    .as_array()
                    .is_some_and(|issues| !issues.is_empty());
                let unresolved_invalid_shape = has_validation_issues
                    && result.target.get("primaryProjectId").is_none()
                    && result.target.get("expectedUpdatedAt").is_none()
                    && if result.action == "CREATE" {
                        result.target.get("entityId").is_none() && target_key_count == 3
                    } else if result.action == "NEW_MANUSCRIPT" {
                        target_entity_id_valid
                            && result.target.get("manuscriptChannel").is_some()
                            && target_key_count == 5
                    } else {
                        target_entity_id_valid && target_key_count == 4
                    };
                if unresolved_invalid_shape {
                    true
                } else {
                    let primary_project_id_valid = match result.target.get("primaryProjectId") {
                        Some(value) if value.is_null() => true,
                        Some(value) => value.as_str().is_some_and(|project_id| {
                            !project_id.trim().is_empty()
                                && project_id.len() <= 200
                                && project_id == target_project_id
                        }),
                        None => false,
                    };
                    target_entity_id_valid
                        && primary_project_id_valid
                        && if result.action == "NEW_MANUSCRIPT" {
                            matches!(
                                result.target.get("manuscriptChannel").and_then(Value::as_str),
                                Some("literature_outline") | Some("dedicated_notes")
                            )
                        } else {
                            result.target.get("manuscriptChannel").is_none()
                        }
                        && if result.action == "CREATE" {
                            result.target.get("entityId").is_none()
                                && result.target.get("primaryProjectId").is_some_and(Value::is_null)
                                && result.target.get("expectedUpdatedAt").is_none()
                                && target_key_count == 4
                        } else if result.action == "UPDATE" {
                            required_json_text_field(&result.target, "expectedUpdatedAt")?.len() <= 80
                                && target_key_count == 6
                        } else if result.action == "NEW_MANUSCRIPT" {
                            result.target.get("expectedUpdatedAt").is_none()
                                && target_key_count == 6
                        } else {
                            result.target.get("expectedUpdatedAt").is_none()
                                && target_key_count == 5
                        }
                }
                }
            }
            _ => false,
        };
        if !result.target.is_object()
            || target_project_id.len() > 200
            || !target_shape_valid
        {
            return Err(fail(
                "AI_STANDARD_RESULT_INVALID",
                "Standard Results must use an exact canonical Route, Task, Finding, Review, Experiment, ExperimentRun, Literature, or Outputs target",
            ));
        }
        let quick_target = result.source.get("quickAnalysisTarget");
        let quick_target_required = result.action == "NEW_MANUSCRIPT"
            && matches!(
                target_module,
                "finding" | "resultItem" | "outputCandidate" | "outputGap" | "researchOutput"
            );
        let quick_target_valid = match quick_target {
            Some(value) => value.as_object().is_some_and(|quick| {
                quick.len() == 7
                    && quick.get("ownerType").and_then(Value::as_str) == Some(target_module)
                    && quick.get("ownerId").and_then(Value::as_str)
                        == result.target.get("entityId").and_then(Value::as_str)
                    && quick.get("channel").and_then(Value::as_str)
                        == result.target.get("manuscriptChannel").and_then(Value::as_str)
                    && quick.get("projectOrScopeId").and_then(Value::as_str)
                        == Some(target_project_id)
                    && ["sourceFileRefId", "sourceDirectoryFileRefId", "whitelistFingerprint"]
                        .iter()
                        .all(|field| {
                            quick.get(*field).and_then(Value::as_str).is_some_and(|text| {
                                !text.trim().is_empty() && text.len() <= 200
                            })
                        })
                    && is_canonical_quick_analysis_owner_channel(
                        target_module,
                        quick.get("channel").and_then(Value::as_str),
                    )
            }),
            None => !quick_target_required,
        };
        if !quick_target_valid {
            return Err(fail(
                "AI_STANDARD_RESULT_INVALID",
                "Quick Analysis Standard Results require one exact canonical owner/channel/source target",
            ));
        }
        let selected_experiment_ids = result
            .source
            .get("selectedExperimentIds")
            .and_then(Value::as_array);
        let experiment_source_valid = target_module != "experiment"
            || result.action == "CREATE"
            || selected_experiment_ids.is_some_and(|ids| {
                !ids.is_empty()
                    && ids.iter().all(|id| {
                        id.as_str().is_some_and(|text| !text.trim().is_empty() && text.len() <= 200)
                    })
                    && result.target.get("entityId").and_then(Value::as_str).is_some_and(
                            |entity_id| ids.iter().any(|id| id.as_str() == Some(entity_id)),
                        )
            });
        let selected_experiment_run_ids = result
            .source
            .get("selectedExperimentRunIds")
            .and_then(Value::as_array);
        let experiment_run_parent_relations = result
            .source
            .get("experimentRunParentRelations")
            .and_then(Value::as_array);
        let exact_sibling_parent_valid = if target_module == "experimentRun"
            && result.action == "CREATE"
        {
            let metadata = result
                .original_payload
                .get("_labpod")
                .and_then(Value::as_object);
            let parent_ref = metadata
                .and_then(|value| value.get("parentProposalRef"))
                .and_then(Value::as_str);
            let proposal_ref = metadata
                .and_then(|value| value.get("proposalRef"))
                .and_then(Value::as_str);
            let original_ordinal = metadata
                .and_then(|value| value.get("originalOrdinal"))
                .and_then(Value::as_u64);
            metadata
                .and_then(|value| value.get("protocol"))
                .and_then(Value::as_str)
                == Some("labpod-standard-result-proposal-v1")
                && proposal_ref.is_some_and(|value| !value.trim().is_empty() && value.len() <= 200)
                && original_ordinal == Some(result.ordinal as u64)
                && parent_ref.is_some_and(|value| {
                    !value.trim().is_empty()
                        && value.len() <= 200
                        && input.results[..index].iter().any(|candidate| {
                            candidate.category == "DATA_OPERATION"
                                && candidate.action == "CREATE"
                                && candidate.target.get("module").and_then(Value::as_str)
                                    == Some("experiment")
                                && candidate.target.get("entityType").and_then(Value::as_str)
                                    == Some("experiment")
                                && candidate.target.get("projectId").and_then(Value::as_str)
                                    == Some(target_project_id)
                                && candidate
                                    .original_payload
                                    .get("_labpod")
                                    .and_then(|metadata| metadata.get("proposalRef"))
                                    .and_then(Value::as_str)
                                    == Some(value)
                        })
                })
        } else {
            false
        };
        let experiment_run_source_valid = target_module != "experimentRun"
            || exact_sibling_parent_valid
            || selected_experiment_run_ids.is_some_and(|run_ids| {
                let run_ids_valid = run_ids.iter().all(|id| {
                    id.as_str().is_some_and(|text| !text.trim().is_empty() && text.len() <= 200)
                });
                let relations_valid = experiment_run_parent_relations.is_some_and(|relations| {
                    relations.len() == run_ids.len()
                        && run_ids.iter().all(|run_id| {
                            let Some(run_id) = run_id.as_str() else { return false; };
                            relations.iter().any(|relation| {
                                relation.as_object().is_some_and(|relation| {
                                    relation.get("runId").and_then(Value::as_str) == Some(run_id)
                                        && relation.get("parentExperimentId").and_then(Value::as_str)
                                            .is_some_and(|id| !id.trim().is_empty() && id.len() <= 200)
                                        && relation.get("projectId").and_then(Value::as_str)
                                            == Some(target_project_id)
                                        && relation.get("selectionOrder").and_then(Value::as_u64)
                                            .is_some()
                                })
                            })
                        })
                });
                if !run_ids_valid || !relations_valid {
                    return false;
                }
                if result.action == "CREATE" {
                    let mut direct_parent_ids = BTreeSet::new();
                    let selected_parents_valid = selected_experiment_ids.is_some_and(|ids| {
                        ids.iter().all(|id| {
                            id.as_str().is_some_and(|text| {
                                !text.trim().is_empty()
                                    && text.len() <= 200
                                    && direct_parent_ids.insert(text)
                            })
                        })
                    });
                    let mut relation_parent_ids = BTreeSet::new();
                    let relation_parents_valid = experiment_run_parent_relations.is_some_and(|relations| {
                        relations.iter().all(|relation| {
                            relation.get("parentExperimentId").and_then(Value::as_str)
                                .is_some_and(|id| {
                                    relation_parent_ids.insert(id);
                                    true
                                })
                        })
                    });
                    let canonical_parent_id = if direct_parent_ids.len() == 1 {
                        direct_parent_ids.iter().next().copied()
                    } else if direct_parent_ids.is_empty() && relation_parent_ids.len() == 1 {
                        relation_parent_ids.iter().next().copied()
                    } else {
                        None
                    };
                    selected_parents_valid
                        && relation_parents_valid
                        && canonical_parent_id.is_some()
                        && result.target.get("parentExperimentId").and_then(Value::as_str)
                            == canonical_parent_id
                } else {
                    result.target.get("entityId").and_then(Value::as_str).is_some_and(
                        |entity_id| {
                            run_ids.iter().any(|id| id.as_str() == Some(entity_id))
                                && experiment_run_parent_relations.is_some_and(|relations| {
                                    relations.iter().any(|relation| {
                                        relation.get("runId").and_then(Value::as_str) == Some(entity_id)
                                            && relation.get("parentExperimentId")
                                                == result.target.get("parentExperimentId")
                                    })
                                })
                        },
                    )
                }
            });
        let selected_literature_ids = result
            .source
            .get("selectedLiteratureIds")
            .and_then(Value::as_array);
        let literature_association_tuples = result
            .source
            .get("literatureAssociationTuples")
            .and_then(Value::as_array);
        let literature_source_valid = target_module != "literature"
            || selected_literature_ids.is_some_and(|ids| {
                literature_association_tuples.is_some_and(|tuples| {
                        let mut literature_selection_orders = BTreeSet::new();
                        tuples.len() == ids.len()
                            && ids.iter().enumerate().all(|(index, id)| {
                                let Some(literature_id) = id.as_str() else { return false; };
                                if literature_id.trim().is_empty()
                                    || literature_id.len() > 200
                                    || ids[..index].iter().any(|prior| prior.as_str() == Some(literature_id))
                                {
                                    return false;
                                }
                                let Some(tuple) = tuples[index].as_object() else { return false; };
                                let canonical_project_id = tuple.get("canonicalProjectId");
                                let association_valid = match tuple
                                    .get("projectAssociationKind")
                                    .and_then(Value::as_str)
                                {
                                    Some("assigned") => {
                                        canonical_project_id.and_then(Value::as_str)
                                            == Some(target_project_id)
                                            && tuple.get("conversationProjectEligibilityDisposition")
                                                .and_then(Value::as_str)
                                                == Some("allowed_same_project")
                                    }
                                    Some("projectless") => {
                                        canonical_project_id.is_some_and(Value::is_null)
                                            && tuple.get("conversationProjectEligibilityDisposition")
                                                .and_then(Value::as_str)
                                                == Some("allowed_global_projectless")
                                    }
                                    _ => false,
                                };
                                tuple.len() == 7
                                    && tuple.get("literatureId").and_then(Value::as_str)
                                        == Some(literature_id)
                                    && tuple.get("lifecycleEligibility").and_then(Value::as_str)
                                        == Some("eligible")
                                    && tuple.get("selectionOrder").and_then(Value::as_u64)
                                        .is_some_and(|selection_order| {
                                            literature_selection_orders.insert(selection_order)
                                        })
                                    && tuple.get("normalizedProjectionFingerprint")
                                        .and_then(Value::as_str)
                                        .is_some_and(|fingerprint| {
                                            !fingerprint.trim().is_empty() && fingerprint.len() <= 200
                                        })
                                    && association_valid
                                    && (result.action == "CREATE"
                                        || result.source.get("quickAnalysisTarget")
                                            .is_some_and(Value::is_object)
                                        || result.target.get("entityId").and_then(Value::as_str)
                                            != Some(literature_id)
                                        || tuple.get("canonicalProjectId")
                                            == result.target.get("primaryProjectId"))
                            })
                    })
                    && result.source.get("literatureSelectionAggregateEligibility")
                        .and_then(Value::as_str) == Some("ALLOWED")
                    && (result.action == "CREATE"
                        || result.target.get("entityId").and_then(Value::as_str).is_some_and(
                            |entity_id| ids.iter().any(|id| id.as_str() == Some(entity_id)),
                        ))
            });
        if !result.source.is_object()
            || required_json_text_field(&result.source, "conversationId")?
                != existing.conversation_id
            || required_json_text_field(&result.source, "projectId")?
                != required_json_text_field(&result.target, "projectId")?
            || required_json_text_field(&result.source, "contextReviewFingerprint")?.len() > 200
            || required_json_text_field(&result.source, "discussionFingerprint")?.len() > 200
            || required_json_text_field(&result.source, "triggerMessageId")?.len() > 200
            || !result
                .source
                .get("discussionMessages")
                .is_some_and(Value::is_array)
            || !result.source.get("selectedTaskIds").is_some_and(Value::is_array)
            || !result.source.get("selectedReviewIds").is_some_and(Value::is_array)
            || !result.source.get("selectedExperimentIds").is_some_and(Value::is_array)
            || !result.source.get("selectedExperimentRunIds").is_some_and(Value::is_array)
            || !result.source.get("experimentRunParentRelations").is_some_and(Value::is_array)
            || !result.source.get("selectedLiteratureIds").is_some_and(Value::is_array)
            || !result.source.get("literatureAssociationTuples").is_some_and(Value::is_array)
            || result.source.get("literatureSelectionAggregateEligibility")
                .and_then(Value::as_str) != Some("ALLOWED")
            || !experiment_source_valid
            || !experiment_run_source_valid
            || !literature_source_valid
            || !exact_route_frozen_target_matches(existing, result)
            || !exact_outputs_frozen_target_matches(existing, result)
            || !result
                .source
                .get("authorizedMaterialFileRefIds")
                .is_some_and(Value::is_array)
            || !result
                .source
                .get("approvedContextRequestContributions")
                .is_some_and(Value::is_array)
            || !result.source.get("contextBudget").is_some_and(Value::is_object)
        {
            return Err(fail(
                "AI_STANDARD_RESULT_INVALID",
                "Standard Result source provenance is incomplete or mismatched",
            ));
        }
        if !result.original_payload.is_object()
            || !result.visible_payload.is_object()
            || !result.validation_issues.is_array()
        {
            return Err(fail(
                "AI_STANDARD_RESULT_INVALID",
                "Standard Result payloads and validation issues have invalid shapes",
            ));
        }
        for value in [
            &result.target,
            &result.source,
            &result.original_payload,
            &result.visible_payload,
            &result.validation_issues,
        ] {
            json_text(value, "standardResult")?;
        }
        if let Some(fingerprint) = &result.target_snapshot_fingerprint {
            require_text(fingerprint, "standardResult.targetSnapshotFingerprint", 200)?;
        }
    }
    Ok(())
}

fn insert_standard_result_batch(
    connection: &Connection,
    existing: &AICallAttemptRecord,
    input: &NewAIStandardResultBatchInput,
) -> Result<(), String> {
    validate_standard_result_batch(existing, input)?;
    for result in &input.results {
        connection
            .execute(
                "INSERT INTO ai_standard_results(
                   id,batch_id,ordinal,conversation_id,parse_call_attempt_id,category,action,
                   target_json,source_json,original_payload_json,visible_payload_json,
                   visible_payload_fingerprint,target_snapshot_fingerprint,validation_issues_json,
                   disposition,created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'PENDING',?15,?15)",
                params![
                    result.id,
                    input.id,
                    result.ordinal,
                    existing.conversation_id,
                    existing.id,
                    result.category,
                    result.action,
                    json_text(&result.target, "standardResult.target")?,
                    json_text(&result.source, "standardResult.source")?,
                    json_text(&result.original_payload, "standardResult.originalPayload")?,
                    json_text(&result.visible_payload, "standardResult.visiblePayload")?,
                    result.visible_payload_fingerprint,
                    result.target_snapshot_fingerprint,
                    json_text(&result.validation_issues, "standardResult.validationIssues")?,
                    input.created_at,
                ],
            )
            .map_err(|error| {
                fail(
                    "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
                    error.to_string(),
                )
            })?;
    }
    Ok(())
}

fn assert_idempotent_standard_result_batch(
    connection: &Connection,
    existing: &AICallAttemptRecord,
    input: &SettleAICallAttemptSuccessInput,
) -> Result<(), String> {
    let durable = read_standard_results(connection, &existing.conversation_id)?
        .into_iter()
        .filter(|result| result.parse_call_attempt_id == existing.id)
        .collect::<Vec<_>>();
    let Some(proposed) = input.standard_result_batch.as_ref() else {
        return if durable.is_empty() {
            Ok(())
        } else {
            Err(fail(
                "AI_DURABLE_TERMINAL_CONFLICT",
                "CallAttempt Standard Result batch cannot be removed on replay",
            ))
        };
    };
    validate_standard_result_batch(existing, proposed)?;
    if durable.len() != proposed.results.len() {
        return Err(fail(
            "AI_DURABLE_TERMINAL_CONFLICT",
            "CallAttempt Standard Result batch cannot be overwritten",
        ));
    }
    for (record, result) in durable.iter().zip(&proposed.results) {
        if record.id != result.id
            || record.batch_id != proposed.id
            || record.ordinal != result.ordinal
            || record.category != result.category
            || record.action != result.action
            || record.target != result.target
            || record.source != result.source
            || record.original_payload != result.original_payload
            || record.target_snapshot_fingerprint != result.target_snapshot_fingerprint
            || record.created_at != proposed.created_at
        {
            return Err(fail(
                "AI_DURABLE_TERMINAL_CONFLICT",
                "CallAttempt Standard Result batch cannot be overwritten",
            ));
        }
    }
    Ok(())
}

fn assert_idempotent_success(
    connection: &Connection,
    existing: &AICallAttemptRecord,
    input: &SettleAICallAttemptSuccessInput,
) -> Result<(), String> {
    let usage = usage_tuple(&input.usage);
    let expected_result_id = input
        .assistant_message
        .as_ref()
        .map(|message| message.id.as_str());
    if existing.status != "succeeded"
        || existing.provider != input.provider
        || existing.model != input.model
        || existing.response_truncated != input.response_truncated
        || existing.usage_input_tokens != usage.0
        || existing.usage_output_tokens != usage.1
        || existing.usage_total_tokens != usage.2
        || existing.result_message_id.as_deref() != expected_result_id
        || existing.settled_at.as_deref() != Some(input.settled_at.as_str())
    {
        return Err(fail(
            "AI_DURABLE_TERMINAL_CONFLICT",
            "CallAttempt terminal success cannot be overwritten",
        ));
    }
    if let Some(message) = &input.assistant_message {
        let durable: (String, String, String) = connection
            .query_row(
                "SELECT role,content,created_at FROM ai_messages WHERE id=?1",
                [&message.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
        if durable
            != (
                "assistant".to_string(),
                message.content.clone(),
                message.created_at.clone(),
            )
        {
            return Err(fail(
                "AI_DURABLE_TERMINAL_CONFLICT",
                "CallAttempt result Message cannot be overwritten",
            ));
        }
    }
    assert_idempotent_context_request(connection, existing, input)?;
    assert_idempotent_standard_result_batch(connection, existing, input)?;
    Ok(())
}

fn is_parse_supplemental_context_phase_a_attempt(existing: &AICallAttemptRecord) -> bool {
    if existing.purpose != "parse_draft" {
        return false;
    }
    let Some(source_refs) = existing.context_source_refs.as_array() else {
        return false;
    };
    let workflow_refs = source_refs
        .iter()
        .filter(|value| {
            value.get("field").and_then(Value::as_str)
                == Some("parseSupplementalContextWorkflow")
        })
        .collect::<Vec<_>>();
    if workflow_refs.len() != 1 {
        return false;
    }
    let marker = workflow_refs[0];
    marker
        .get("parseSupplementalContextWorkflowKind")
        .and_then(Value::as_str)
        == Some("PARSE_DRAFT")
        && marker
            .get("parseSupplementalContextPhase")
            .and_then(Value::as_str)
            == Some("PHASE_A_ELIGIBLE")
        && marker
            .get("parseSupplementalContextLogicalAttemptId")
            .and_then(Value::as_str)
            == Some(existing.id.as_str())
        && marker.get("entityId").and_then(Value::as_str) == Some(existing.id.as_str())
        && marker
            .get("parseSupplementalContextRequestLimit")
            .and_then(Value::as_i64)
            == Some(1)
        && marker
            .get("parseSupplementalContextRequestRemaining")
            .and_then(Value::as_i64)
            == Some(1)
        && marker
            .get("parseSupplementalContextAutomaticContinuationCount")
            .and_then(Value::as_i64)
            == Some(0)
}

pub(crate) fn settle_ai_call_attempt_success_in_connection(
    connection: &mut Connection,
    input: &SettleAICallAttemptSuccessInput,
) -> Result<AIConversationReadback, String> {
    require_text(&input.attempt_id, "attemptId", 200)?;
    require_text(&input.provider, "provider", 120)?;
    require_text(&input.model, "model", 200)?;
    require_text(&input.settled_at, "settledAt", 80)?;
    validate_usage(&input.usage)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            fail(
                "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
    let existing = read_call_attempt_by_id(&transaction, &input.attempt_id)?;
    let conversation_id = existing.conversation_id.clone();
    if existing.status != "started" {
        assert_idempotent_success(&transaction, &existing, input)?;
        transaction.commit().map_err(|error| {
            fail(
                "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
        return read_ai_conversation_in_connection(connection, &conversation_id);
    }
    let result_message_id = match (
        existing.purpose.as_str(),
        &input.assistant_message,
        &input.context_request,
        &input.standard_result_batch,
    ) {
        ("chat_response", Some(message), _, None)
        | ("parse_draft", Some(message), Some(_), None) => {
            Some(insert_message(&transaction, &conversation_id, "assistant", message)?.id)
        }
        ("parse_draft", None, None, Some(_)) | ("action_draft_generation", None, None, None) => {
            None
        }
        ("parse_draft", None, None, None)
            if is_parse_supplemental_context_phase_a_attempt(&existing) =>
        {
            None
        }
        _ => {
            return Err(fail(
                "AI_DURABLE_INPUT_INVALID",
                "success output children do not match the canonical CallAttempt purpose",
            ))
        }
    };
    let usage = usage_tuple(&input.usage);
    let updated = transaction
        .execute(
            "UPDATE ai_call_attempts SET
               result_message_id=?1,provider=?2,model=?3,status='succeeded',
               response_truncated=?4,usage_input_tokens=?5,usage_output_tokens=?6,
               usage_total_tokens=?7,settled_at=?8
             WHERE id=?9 AND status='started'",
            params![
                result_message_id,
                input.provider,
                input.model,
                input.response_truncated.map(i64::from),
                usage.0,
                usage.1,
                usage.2,
                input.settled_at,
                input.attempt_id,
            ],
        )
        .map_err(|error| {
            fail(
                "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
    if updated != 1 {
        return Err(fail(
            "AI_DURABLE_TERMINAL_CONFLICT",
            "CallAttempt changed before success settlement",
        ));
    }
    if let Some(context_request) = &input.context_request {
        if !matches!(existing.purpose.as_str(), "chat_response" | "parse_draft") {
            return Err(fail(
                "AI_CONTEXT_REQUEST_INVALID",
                "Only a covered conversational CallAttempt may create a Context Request",
            ));
        }
        let source_message_id = result_message_id.as_deref().ok_or_else(|| {
            fail(
                "AI_CONTEXT_REQUEST_INVALID",
                "A Context Request requires its durable source Assistant Message",
            )
        })?;
        insert_context_request(
            &transaction,
            &conversation_id,
            source_message_id,
            &existing.id,
            context_request,
        )?;
    }
    if let Some(standard_result_batch) = &input.standard_result_batch {
        if existing.purpose != "parse_draft" {
            return Err(fail(
                "AI_STANDARD_RESULT_INVALID",
                "Only a successful parse_draft CallAttempt may create Standard Results",
            ));
        }
        insert_standard_result_batch(&transaction, &existing, standard_result_batch)?;
    }
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.settled_at, conversation_id],
        )
        .map_err(|error| {
            fail(
                "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
    transaction.commit().map_err(|error| {
        fail(
            "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
            error.to_string(),
        )
    })?;
    read_ai_conversation_in_connection(connection, &conversation_id)
}

fn assert_idempotent_failure(
    existing: &AICallAttemptRecord,
    input: &SettleAICallAttemptFailureInput,
) -> Result<(), String> {
    if existing.status == "failed"
        && existing.error_code == Some(input.error_code.clone())
        && existing.error_message == input.error_message
        && existing.error_retryable == Some(input.error_retryable)
        && existing.provider_status == input.provider_status
        && existing.settled_at.as_deref() == Some(input.settled_at.as_str())
    {
        return Ok(());
    }
    Err(fail(
        "AI_DURABLE_TERMINAL_CONFLICT",
        "CallAttempt terminal outcome cannot be overwritten",
    ))
}

pub(crate) fn settle_ai_call_attempt_failure_in_connection(
    connection: &mut Connection,
    input: &SettleAICallAttemptFailureInput,
) -> Result<AIConversationReadback, String> {
    require_text(&input.attempt_id, "attemptId", 200)?;
    require_text(&input.error_code, "errorCode", 120)?;
    require_text(&input.settled_at, "settledAt", 80)?;
    if let Some(message) = &input.error_message {
        require_text(message, "errorMessage", MAX_ERROR_CHARS)?;
    }
    if input.provider_status.is_some_and(|status| status < 100) {
        return Err(fail(
            "AI_DURABLE_INPUT_INVALID",
            "providerStatus is invalid",
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            fail(
                "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
    let existing = read_call_attempt_by_id(&transaction, &input.attempt_id)?;
    let conversation_id = existing.conversation_id.clone();
    if existing.status != "started" {
        assert_idempotent_failure(&existing, input)?;
        transaction.commit().map_err(|error| {
            fail(
                "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
        return read_ai_conversation_in_connection(connection, &conversation_id);
    }
    let updated = transaction
        .execute(
            "UPDATE ai_call_attempts SET
               status='failed',error_code=?1,error_message=?2,error_retryable=?3,
               provider_status=?4,settled_at=?5
             WHERE id=?6 AND status='started'",
            params![
                input.error_code,
                input.error_message,
                i64::from(input.error_retryable),
                input.provider_status,
                input.settled_at,
                input.attempt_id,
            ],
        )
        .map_err(|error| {
            fail(
                "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
    if updated != 1 {
        return Err(fail(
            "AI_DURABLE_TERMINAL_CONFLICT",
            "CallAttempt changed before failure settlement",
        ));
    }
    transaction
        .execute(
            "UPDATE ai_conversations SET updated_at=?1 WHERE id=?2",
            params![input.settled_at, conversation_id],
        )
        .map_err(|error| {
            fail(
                "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
                error.to_string(),
            )
        })?;
    transaction.commit().map_err(|error| {
        fail(
            "AI_DURABLE_POST_PROVIDER_PERSISTENCE_FAILED",
            error.to_string(),
        )
    })?;
    read_ai_conversation_in_connection(connection, &conversation_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_create_ai_conversation(
    app_handle: AppHandle,
    input: CreateAIConversationInput,
) -> Result<AIConversationRecord, String> {
    let connection = super::open_connection(&app_handle)?;
    create_ai_conversation_in_connection(&connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_prepare_ai_call_attempt(
    app_handle: AppHandle,
    input: PrepareAICallAttemptInput,
) -> Result<PreparedAICallAttempt, String> {
    let mut connection = super::open_connection(&app_handle)?;
    prepare_ai_call_attempt_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_prepare_ai_retry_regenerate_attempt(
    app_handle: AppHandle,
    input: PrepareAIRetryRegenerateAttemptInput,
) -> Result<PreparedAICallAttempt, String> {
    let mut connection = super::open_connection(&app_handle)?;
    prepare_ai_retry_regenerate_attempt_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_prepare_ai_context_request_followup(
    app_handle: AppHandle,
    input: PrepareAIContextRequestFollowupInput,
) -> Result<PreparedAICallAttempt, String> {
    let mut connection = super::open_connection(&app_handle)?;
    prepare_ai_context_request_followup_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_reject_ai_context_request(
    app_handle: AppHandle,
    input: DecideAIContextRequestInput,
) -> Result<AIConversationReadback, String> {
    let mut connection = super::open_connection(&app_handle)?;
    reject_ai_context_request_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_mark_ai_context_request_stale(
    app_handle: AppHandle,
    input: MarkAIContextRequestStaleInput,
) -> Result<AIConversationReadback, String> {
    let mut connection = super::open_connection(&app_handle)?;
    mark_ai_context_request_stale_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_update_ai_standard_result_draft(
    app_handle: AppHandle,
    input: UpdateAIStandardResultDraftInput,
) -> Result<AIConversationReadback, String> {
    let mut connection = super::open_connection(&app_handle)?;
    update_ai_standard_result_draft_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_dismiss_ai_standard_result(
    app_handle: AppHandle,
    input: DecideAIStandardResultInput,
) -> Result<AIConversationReadback, String> {
    let mut connection = super::open_connection(&app_handle)?;
    dismiss_ai_standard_result_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_begin_ai_standard_result_confirmation(
    app_handle: AppHandle,
    input: BeginAIStandardResultConfirmationInput,
) -> Result<AIConversationReadback, String> {
    let mut connection = super::open_connection(&app_handle)?;
    begin_ai_standard_result_confirmation_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_settle_ai_standard_result_effect(
    app_handle: AppHandle,
    input: SettleAIStandardResultEffectInput,
) -> Result<AIConversationReadback, String> {
    let mut connection = super::open_connection(&app_handle)?;
    settle_ai_standard_result_effect_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_fail_ai_standard_result(
    app_handle: AppHandle,
    input: FailAIStandardResultInput,
) -> Result<AIConversationReadback, String> {
    let mut connection = super::open_connection(&app_handle)?;
    fail_ai_standard_result_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_settle_ai_call_attempt_success(
    app_handle: AppHandle,
    input: SettleAICallAttemptSuccessInput,
) -> Result<AIConversationReadback, String> {
    let mut connection = super::open_connection(&app_handle)?;
    settle_ai_call_attempt_success_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_settle_ai_call_attempt_failure(
    app_handle: AppHandle,
    input: SettleAICallAttemptFailureInput,
) -> Result<AIConversationReadback, String> {
    let mut connection = super::open_connection(&app_handle)?;
    settle_ai_call_attempt_failure_in_connection(&mut connection, &input)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_read_ai_conversation(
    app_handle: AppHandle,
    conversation_id: String,
) -> Result<AIConversationReadback, String> {
    let connection = super::open_connection(&app_handle)?;
    read_ai_conversation_in_connection(&connection, &conversation_id)
}

fn list_ai_conversations_in_connection(
    connection: &Connection,
) -> Result<Vec<AIConversationSummaryRecord>, String> {
    let mut statement = connection
        .prepare(
            "WITH first_user AS (
               SELECT conversation_id, MIN(sequence) AS sequence
               FROM ai_messages WHERE role='user' AND message_kind='text' GROUP BY conversation_id
             ), latest_message AS (
               SELECT conversation_id, MAX(sequence) AS sequence
               FROM ai_messages WHERE message_kind='text' GROUP BY conversation_id
             ), message_counts AS (
               SELECT conversation_id, COUNT(*) AS message_count
               FROM ai_messages WHERE message_kind='text' GROUP BY conversation_id
             )
             SELECT c.id,c.stable_key,c.created_at,c.updated_at,
                    substr(first.content,1,240),substr(latest.content,1,400),
                    COALESCE(counts.message_count,0)
             FROM ai_conversations c
             LEFT JOIN first_user first_id ON first_id.conversation_id=c.id
             LEFT JOIN ai_messages first ON first.conversation_id=c.id
                  AND first.sequence=first_id.sequence
             LEFT JOIN latest_message latest_id ON latest_id.conversation_id=c.id
             LEFT JOIN ai_messages latest ON latest.conversation_id=c.id
                  AND latest.sequence=latest_id.sequence
             LEFT JOIN message_counts counts ON counts.conversation_id=c.id
             ORDER BY c.updated_at DESC,c.id ASC",
        )
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok(AIConversationSummaryRecord {
                id: row.get(0)?,
                stable_key: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                first_user_message: row.get(4)?,
                latest_message: row.get(5)?,
                message_count: row.get(6)?,
            })
        })
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| fail("AI_DURABLE_READ_FAILED", error.to_string()))
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_list_ai_conversations(
    app_handle: AppHandle,
) -> Result<Vec<AIConversationSummaryRecord>, String> {
    let connection = super::open_connection(&app_handle)?;
    list_ai_conversations_in_connection(&connection)
}

#[tauri::command(rename_all = "camelCase")]
pub fn db_list_ai_attachment_file_refs(
    app_handle: AppHandle,
) -> Result<AISelectableFileRefCatalog, String> {
    let connection = super::open_connection(&app_handle)?;
    Ok(AISelectableFileRefCatalog {
        file_refs: list_selectable_file_refs_in_connection(&connection)?,
        effective_readable_selection_limit: MAX_AUTHORIZED_FILE_REFS_PER_CALL
            .min(MAX_READABLE_MATERIAL_FILES_PER_CALL),
        supported_extensions: AI_MATERIAL_SUPPORTED_EXTENSIONS
            .iter()
            .map(|extension| (*extension).to_string())
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_database_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("labpod-b1-{label}-{nonce}"))
            .join("labpod.sqlite3")
    }

    fn normal_qa_constraint_source_ref() -> serde_json::Value {
        serde_json::json!({
            "module": "ai",
            "entityType": "system",
            "entityId": "labpod.ai.constraint.normal_qa",
            "field": "constraintDescriptor",
            "sourceKind": "systemGenerated",
            "constraintCategory": "NORMAL_QA",
            "constraintLifecycle": "ACTIVE",
            "constraintRef": "labpod.ai.constraint.normal_qa",
            "constraintVersion": 1,
            "sharedInvariantRef": "labpod.ai.constraint.shared_invariant",
            "sharedInvariantVersion": 2,
            "boundedPolicyRefs": ["labpod.ai.policy.normal_qa.presentation"]
        })
    }

    #[test]
    fn lp14_a1_f27_literature_structured_state_receipt_is_exact() {
        let exact = serde_json::json!({
            "structuredState": {
                "literature_outline": {
                    "research_problem": "question",
                    "application_object": null,
                    "method_overview": "method",
                    "main_conclusion": "conclusion",
                    "limitations": null,
                    "other": null
                },
                "dedicated_notes": {
                    "summary": null,
                    "project_relevance": "relevance",
                    "related_objects": null,
                    "reusable_methods": "reuse",
                    "comparable_conclusions": "compare",
                    "other": null
                }
            }
        });
        assert!(lp14_a1_f27_literature_structured_state_matches(&exact));

        let mut missing_field = exact.clone();
        missing_field["structuredState"]["literature_outline"]
            .as_object_mut()
            .unwrap()
            .remove("research_problem");
        assert!(!lp14_a1_f27_literature_structured_state_matches(
            &missing_field,
        ));

        let mut extra_field = exact.clone();
        extra_field["structuredState"]["dedicated_notes"]["invented"] =
            serde_json::json!("not allowed");
        assert!(!lp14_a1_f27_literature_structured_state_matches(
            &extra_field,
        ));
    }

    #[test]
    fn lp14_a1_c4_parent_settlement_is_exact_and_fails_closed() {
        let body = "# C4 Review\n\nExact parent-owned manuscript body.";
        let child_result_id = "result-c4-review:manuscript:primary";
        let body_fingerprint = lp14_a1_c4_canonical_fingerprint(
            &serde_json::Value::String(body.into()),
        )
        .unwrap();
        let current = AIStandardResultRecord {
            id: "result-c4-review".into(),
            batch_id: "batch-c4-review".into(),
            ordinal: 1,
            conversation_id: "conversation-c4-review".into(),
            parse_call_attempt_id: "attempt-c4-review".into(),
            category: "DATA_OPERATION".into(),
            action: "UPDATE".into(),
            target: serde_json::json!({
                "module":"review","entityType":"review","entityId":"review-c4",
                "projectId":"project-c4"
            }),
            source: serde_json::json!({"projectId":"project-c4"}),
            original_payload: serde_json::json!({
                "title":"C4 Review","manuscriptEffects":[{"channel":"primary","body":body}]
            }),
            visible_payload: serde_json::json!({
                "title":"C4 Review","manuscriptEffects":[{"channel":"primary","body":body}]
            }),
            visible_payload_fingerprint: "lp13-a6-11111111".into(),
            target_snapshot_fingerprint: Some("lp13-a6-22222222".into()),
            validation_issues: serde_json::json!([]),
            disposition: "PENDING".into(),
            confirmation_started_at: Some("2026-08-26T12:00:00.000Z".into()),
            authorization_id: Some("authorization-c4-review".into()),
            confirmed_payload: Some(serde_json::json!({
                "title":"C4 Review","manuscriptEffects":[{"channel":"primary","body":body}]
            })),
            confirmed_payload_fingerprint: Some("lp13-a6-11111111".into()),
            decided_at: None,
            effect_receipt: None,
            failure_code: None,
            failure_message: None,
            created_at: "2026-08-26T12:00:00.000Z".into(),
            updated_at: "2026-08-26T12:00:00.000Z".into(),
        };
        let business_receipt = serde_json::json!({
            "module":"review","entityType":"review","entityId":"review-c4",
            "operation":"UPDATE","service":"planningService.updateReview",
            "canonicalReadback":{"id":"review-c4","projectId":"project-c4","resultCorrelationId":"result-c4-review"}
        });
        let child_receipt = serde_json::json!({
            "module":"review","entityType":"fileRef","entityId":"file-ref-c4-review",
            "operation":"NEW_MANUSCRIPT","service":"reviewCandidateService.saveCandidate",
            "canonicalReadback":{
                "projectId":"project-c4","reviewId":"review-c4","manuscriptChannel":"primary",
                "operationId":child_result_id,"candidateRequestId":child_result_id,
                "fileRefId":"file-ref-c4-review","resourceKind":"file","fileRole":"manuscript",
                "physicalEncoding":"utf-8","documentLineEnding":"LF",
                "confirmedBodyFingerprint":body_fingerprint,
                "physicalBodyFingerprint":body_fingerprint,
                "bindingBefore":{"id":"binding-c4"},"bindingAfter":{"id":"binding-c4"},
                "currentChanged":false,"formalSwitchInvoked":false
            }
        });
        let mut aggregate = business_receipt.clone();
        aggregate["standardResultParentSettlement"] = serde_json::json!({
            "productAction":"UPDATE",
            "requestedBusinessEffect":true,
            "requestedManuscriptEffects":["primary"],
            "settledEffectCount":2,
            "businessReceipt":business_receipt,
            "manuscriptReceipts":[{"channel":"primary","receipt":child_receipt}]
        });
        assert!(lp14_a1_c4_parent_settlement_matches(
            &current,
            "authorization-c4-review",
            &aggregate,
        ));

        let mut wrong_count = aggregate.clone();
        wrong_count["standardResultParentSettlement"]["settledEffectCount"] =
            serde_json::json!(1);
        assert!(!lp14_a1_c4_parent_settlement_matches(
            &current,
            "authorization-c4-review",
            &wrong_count,
        ));

        let mut wrong_channel = aggregate.clone();
        wrong_channel["standardResultParentSettlement"]["manuscriptReceipts"][0]
            ["channel"] = serde_json::json!("dedicated_notes");
        assert!(!lp14_a1_c4_parent_settlement_matches(
            &current,
            "authorization-c4-review",
            &wrong_channel,
        ));

        assert!(!lp14_a1_c4_parent_settlement_matches(
            &current,
            "authorization-c4-review",
            &business_receipt,
        ));
    }

    fn e5_output_gap_current(manuscript_only: bool) -> AIStandardResultRecord {
        let body = "# E5 OutputGap\n\nExact shared candidate body.";
        let payload = if manuscript_only {
            serde_json::json!({"manuscriptEffects":[{"channel":"primary","body":body}]})
        } else {
            serde_json::json!({
                "description":"E5 durable business delta",
                "manuscriptEffects":[{"channel":"primary","body":body}]
            })
        };
        AIStandardResultRecord {
            id: "result-e5-output-gap".into(),
            batch_id: "batch-e5-output-gap".into(),
            ordinal: 1,
            conversation_id: "conversation-e5-output-gap".into(),
            parse_call_attempt_id: "attempt-e5-output-gap".into(),
            category: "DATA_OPERATION".into(),
            action: "UPDATE".into(),
            target: serde_json::json!({
                "module":"outputGap","entityType":"outputGap","entityId":"output-gap-e5",
                "projectId":"project-e5"
            }),
            source: serde_json::json!({"projectId":"project-e5"}),
            original_payload: payload.clone(),
            visible_payload: payload.clone(),
            visible_payload_fingerprint: "lp13-a6-e5000001".into(),
            target_snapshot_fingerprint: Some("lp13-a6-e5000002".into()),
            validation_issues: serde_json::json!([]),
            disposition: "PENDING".into(),
            confirmation_started_at: Some("2026-08-28T16:00:00.000Z".into()),
            authorization_id: Some("authorization-e5-output-gap".into()),
            confirmed_payload: Some(payload),
            confirmed_payload_fingerprint: Some("lp13-a6-e5000001".into()),
            decided_at: None,
            effect_receipt: None,
            failure_code: None,
            failure_message: None,
            created_at: "2026-08-28T16:00:00.000Z".into(),
            updated_at: "2026-08-28T16:00:00.000Z".into(),
        }
    }

    fn e5_output_gap_business_receipt() -> Value {
        serde_json::json!({
            "module":"outputGap","entityType":"outputGap","entityId":"output-gap-e5",
            "operation":"UPDATE","service":"outputConversionService.updateOutputGap",
            "canonicalReadback":{
                "id":"output-gap-e5","projectId":"project-e5","title":"E5 gap",
                "brief":"E5 durable business delta","structuredSummary":[],
                "updatedAt":"2026-08-28T16:00:01.000Z","resultId":"result-e5-output-gap",
                "authorizationId":"authorization-e5-output-gap",
                "confirmedPayloadFingerprint":"lp13-a6-e5000001"
            }
        })
    }

    fn e5_output_gap_shared_candidate_receipt() -> Value {
        let body = "# E5 OutputGap\n\nExact shared candidate body.";
        let body_fingerprint = lp14_a1_c4_canonical_fingerprint(&Value::String(body.into())).unwrap();
        let binding = serde_json::json!({
            "id":"binding-e5","ownerType":"outputGap","ownerId":"output-gap-e5",
            "manuscriptChannel":"primary","defaultFolderFileRefId":"folder-e5",
            "defaultManuscriptFileRefId":"current-e5","currentFileRefId":"current-e5",
            "updatedAt":"2026-08-28T15:00:00.000Z"
        });
        let mut canonical = serde_json::json!({
            "projectId":"project-e5","parentAction":"UPDATE",
            "parentResultId":"result-e5-output-gap",
            "effectResultId":"result-e5-output-gap:manuscript:primary",
            "parseCallAttemptId":"attempt-e5-output-gap",
            "authorizationId":"authorization-e5-output-gap",
            "authorizationSource":"DERIVED_FROM_STANDARD_OPERATION_CONFIRMATION",
            "ownerType":"outputGap","ownerId":"output-gap-e5","manuscriptChannel":"primary",
            "candidateRequestId":"result-e5-output-gap:manuscript:primary",
            "candidateFileRefId":"candidate-e5","candidatePath":"N:/managed/e5/candidate.md",
            "candidatePathIdentityKey":"n:/managed/e5/candidate.md",
            "candidateDirectoryPathIdentityKey":"n:/managed/e5",
            "defaultFolderFileRefId":"folder-e5","bindingBefore":binding,"bindingAfter":binding,
            "currentFileRefIdBefore":"current-e5","currentFileRefIdAfter":"current-e5"
        });
        let tail = serde_json::json!({
            "defaultManuscriptFileRefIdBefore":"current-e5",
            "defaultManuscriptFileRefIdAfter":"current-e5",
            "currentPathBefore":"N:/managed/e5/current.md","currentPathAfter":"N:/managed/e5/current.md",
            "defaultPathBefore":"N:/managed/e5/current.md","defaultPathAfter":"N:/managed/e5/current.md",
            "currentExactBytesPreserved":true,"defaultExactBytesPreserved":true,
            "bindingPreserved":true,"candidateDistinctFromCurrentAndDefault":true,
            "currentChanged":false,"defaultChanged":false,"formalSwitchInvoked":false,
            "confirmedBodyFingerprint":body_fingerprint,"physicalBodyFingerprint":body_fingerprint,
            "physicalEncoding":"utf-8","physicalSizeBytes":256,
            "bodyNormalization":"CRLF_TO_LF_AT_STANDARD_RESULT_ADMISSION",
            "terminalCommitState":"POST_PUBLISH_FILE_REF_PHYSICAL_AND_PROTECTED_BYTES_CONFIRMED"
        });
        canonical
            .as_object_mut()
            .unwrap()
            .extend(tail.as_object().unwrap().clone());
        serde_json::json!({
            "module":"outputGap","entityType":"fileRef","entityId":"candidate-e5",
            "operation":"NEW_MANUSCRIPT","service":"candidateManuscriptService.saveCandidate",
            "canonicalReadback":canonical
        })
    }

    fn e5_full_output_gap_aggregate() -> Value {
        let business = e5_output_gap_business_receipt();
        let candidate = e5_output_gap_shared_candidate_receipt();
        let mut aggregate = business.clone();
        aggregate["standardResultParentSettlement"] = serde_json::json!({
            "parentResultId":"result-e5-output-gap","productAction":"UPDATE",
            "settledTarget":{
                "module":"outputGap","entityType":"outputGap","entityId":"output-gap-e5",
                "projectId":"project-e5"
            },
            "outcomeClass":"FULL_SUCCESS","requestedBusinessEffect":true,
            "businessOutcome":"PROVEN_SUCCESS","requestedManuscriptEffects":["primary"],
            "settledEffectCount":2,"businessReceipt":business,
            "manuscriptReceipts":[{"channel":"primary","receipt":candidate}],
            "manuscriptOutcomes":[{
                "effectResultId":"result-e5-output-gap:manuscript:primary","channel":"primary",
                "outcome":"PROVEN_SUCCESS","receipt":candidate,
                "failureCode":null,"failureMessage":null
            }]
        });
        aggregate
    }

    #[test]
    fn lp14_a1_e5_shared_receipt_and_truthful_aggregate_are_strict() {
        let current = e5_output_gap_current(false);
        let candidate = e5_output_gap_shared_candidate_receipt();
        let full = e5_full_output_gap_aggregate();
        assert!(lp14_a1_e5_shared_candidate_receipt_matches(
            &current,
            "authorization-e5-output-gap",
            "output-gap-e5",
            "primary",
            "# E5 OutputGap\n\nExact shared candidate body.",
            &candidate,
        ));
        assert!(lp14_a1_c4_parent_settlement_matches(
            &current,
            "authorization-e5-output-gap",
            &full,
        ));

        let mut partial = e5_output_gap_business_receipt();
        partial["standardResultParentSettlement"] = serde_json::json!({
            "parentResultId":"result-e5-output-gap","productAction":"UPDATE",
            "settledTarget":current.target,"outcomeClass":"PROVEN_PARTIAL",
            "requestedBusinessEffect":true,"businessOutcome":"PROVEN_SUCCESS",
            "requestedManuscriptEffects":["primary"],"settledEffectCount":1,
            "businessReceipt":e5_output_gap_business_receipt(),"manuscriptReceipts":[],
            "manuscriptOutcomes":[{
                "effectResultId":"result-e5-output-gap:manuscript:primary","channel":"primary",
                "outcome":"PROVEN_NO_EFFECT_FAILURE","receipt":null,
                "failureCode":"TEST_WRITER_NOT_INVOKED","failureMessage":"Injected before writer invocation."
            }]
        });
        assert!(lp14_a1_c4_parent_settlement_matches(
            &current,
            "authorization-e5-output-gap",
            &partial,
        ));

        let manuscript_only = e5_output_gap_current(true);
        let mut root = serde_json::json!({
            "module":"outputGap","entityType":"outputGap","entityId":"output-gap-e5",
            "operation":"UPDATE","service":"aiStandardResultAdapterService.aggregateParentReceipt",
            "canonicalReadback":{
                "projectId":"project-e5","parentResultId":"result-e5-output-gap",
                "parentAction":"UPDATE","parentTarget":manuscript_only.target,
                "requestedBusinessEffect":false
            }
        });
        root["standardResultParentSettlement"] = serde_json::json!({
            "parentResultId":"result-e5-output-gap","productAction":"UPDATE",
            "settledTarget":manuscript_only.target,"outcomeClass":"FULL_SUCCESS",
            "requestedBusinessEffect":false,"businessOutcome":"NOT_REQUESTED",
            "requestedManuscriptEffects":["primary"],"settledEffectCount":1,
            "businessReceipt":null,"manuscriptReceipts":[{"channel":"primary","receipt":candidate}],
            "manuscriptOutcomes":[{
                "effectResultId":"result-e5-output-gap:manuscript:primary","channel":"primary",
                "outcome":"PROVEN_SUCCESS","receipt":candidate,
                "failureCode":null,"failureMessage":null
            }]
        });
        assert!(lp14_a1_c4_parent_settlement_matches(
            &manuscript_only,
            "authorization-e5-output-gap",
            &root,
        ));

        assert!(!lp14_a1_c4_parent_settlement_matches(
            &current,
            "authorization-e5-output-gap",
            &root,
        ));

        let mut wrong_service = full.clone();
        wrong_service["standardResultParentSettlement"]["manuscriptReceipts"][0]["receipt"]["service"] =
            serde_json::json!("forgedWriter.save");
        wrong_service["standardResultParentSettlement"]["manuscriptOutcomes"][0]["receipt"]["service"] =
            serde_json::json!("forgedWriter.save");
        assert!(!lp14_a1_c4_parent_settlement_matches(&current, "authorization-e5-output-gap", &wrong_service));

        let mut wrong_parent = full.clone();
        wrong_parent["standardResultParentSettlement"]["parentResultId"] = serde_json::json!("wrong-parent");
        assert!(!lp14_a1_c4_parent_settlement_matches(&current, "authorization-e5-output-gap", &wrong_parent));

        let mut wrong_owner = full.clone();
        wrong_owner["standardResultParentSettlement"]["manuscriptReceipts"][0]["receipt"]
            ["canonicalReadback"]["ownerId"] = serde_json::json!("wrong-owner");
        wrong_owner["standardResultParentSettlement"]["manuscriptOutcomes"][0]["receipt"]
            ["canonicalReadback"]["ownerId"] = serde_json::json!("wrong-owner");
        assert!(!lp14_a1_c4_parent_settlement_matches(&current, "authorization-e5-output-gap", &wrong_owner));

        let mut wrong_request = full.clone();
        wrong_request["standardResultParentSettlement"]["manuscriptReceipts"][0]["receipt"]
            ["canonicalReadback"]["candidateRequestId"] = serde_json::json!("wrong-request");
        wrong_request["standardResultParentSettlement"]["manuscriptOutcomes"][0]["receipt"]
            ["canonicalReadback"]["candidateRequestId"] = serde_json::json!("wrong-request");
        assert!(!lp14_a1_c4_parent_settlement_matches(&current, "authorization-e5-output-gap", &wrong_request));

        let mut wrong_binding = full.clone();
        for path in [
            "/standardResultParentSettlement/manuscriptReceipts/0/receipt/canonicalReadback/bindingBefore/currentFileRefId",
            "/standardResultParentSettlement/manuscriptReceipts/0/receipt/canonicalReadback/bindingAfter/currentFileRefId",
            "/standardResultParentSettlement/manuscriptOutcomes/0/receipt/canonicalReadback/bindingBefore/currentFileRefId",
            "/standardResultParentSettlement/manuscriptOutcomes/0/receipt/canonicalReadback/bindingAfter/currentFileRefId",
        ] {
            *wrong_binding.pointer_mut(path).unwrap() = serde_json::json!("forged-current");
        }
        assert!(!lp14_a1_c4_parent_settlement_matches(&current, "authorization-e5-output-gap", &wrong_binding));

        let mut unrequested = full.clone();
        unrequested["standardResultParentSettlement"]["requestedManuscriptEffects"][0] =
            serde_json::json!("dedicated_notes");
        assert!(!lp14_a1_c4_parent_settlement_matches(&current, "authorization-e5-output-gap", &unrequested));

        let mut child_as_root = full.clone();
        child_as_root["operation"] = serde_json::json!("NEW_MANUSCRIPT");
        child_as_root["entityType"] = serde_json::json!("fileRef");
        assert!(!lp14_a1_c4_parent_settlement_matches(&current, "authorization-e5-output-gap", &child_as_root));

        let mut false_success = partial.clone();
        false_success["standardResultParentSettlement"]["manuscriptOutcomes"][0]["outcome"] =
            serde_json::json!("PROVEN_SUCCESS");
        assert!(!lp14_a1_c4_parent_settlement_matches(&current, "authorization-e5-output-gap", &false_success));
    }

    #[test]
    fn lp14_a1_e5_status_and_receipt_settle_atomically_and_round_trip() {
        let path = temporary_database_path("lp14-a1-e5-atomic-settlement");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-e5-chat",
            "attempt-e5-chat",
            "message-e5-user",
            "2026-08-28T16:10:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-e5-chat",
                "message-e5-assistant",
                "2026-08-28T16:10:01.000Z",
            ),
        )
        .unwrap();
        let mut parse = prepare_parse_attempt_input(
            "attempt-e5-parse",
            "message-e5-user",
            "2026-08-28T16:10:02.000Z",
        );
        parse.context_source_refs
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "module":"outputConversion","entityType":"outputGap","entityId":"output-gap-e5",
                "contextDisposition":"included","contextRole":"primary","isVerified":true
            }));
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let mut batch = standard_result_batch(
            "message-e5-user",
            "2026-08-28T16:10:03.000Z",
        );
        batch.id = "batch-e5-output-gap".into();
        batch.results.truncate(1);
        let result = &mut batch.results[0];
        result.id = "result-e5-output-gap".into();
        result.action = "UPDATE".into();
        result.target = serde_json::json!({
            "module":"outputGap","entityType":"outputGap","entityId":"output-gap-e5",
            "projectId":"project-1"
        });
        result.source = parse_source_snapshot("message-e5-user");
        let body = "# E5 OutputGap\n\nExact shared candidate body.";
        result.original_payload = serde_json::json!({
            "description":"E5 durable business delta",
            "manuscriptEffects":[{"channel":"primary","body":body}]
        });
        result.visible_payload = result.original_payload.clone();
        result.visible_payload_fingerprint = "lp13-a6-e5000001".into();
        result.target_snapshot_fingerprint = Some("lp13-a6-e5000002".into());
        result.validation_issues = serde_json::json!([]);
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-e5-parse".into(),
                provider: "deterministic".into(),
                model: "fixture".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch),
                settled_at: "2026-08-28T16:10:03.000Z".into(),
            },
        )
        .expect("E5 aggregate fixture must enter through canonical Parse settlement");
        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "result-e5-output-gap".into(),
                parse_call_attempt_id: "attempt-e5-parse".into(),
                expected_visible_payload_fingerprint: "lp13-a6-e5000001".into(),
                authorization_id: "authorization-e5-output-gap".into(),
                confirmed_payload: serde_json::json!({
                    "description":"E5 durable business delta",
                    "manuscriptEffects":[{"channel":"primary","body":body}]
                }),
                confirmed_payload_fingerprint: "lp13-a6-e5000001".into(),
                started_at: "2026-08-28T16:10:04.000Z".into(),
            },
        )
        .unwrap();
        let mut business_receipt = e5_output_gap_business_receipt();
        business_receipt["canonicalReadback"]["projectId"] = serde_json::json!("project-1");
        let mut receipt = business_receipt.clone();
        receipt["standardResultParentSettlement"] = serde_json::json!({
            "parentResultId":"result-e5-output-gap","productAction":"UPDATE",
            "settledTarget":{
                "module":"outputGap","entityType":"outputGap","entityId":"output-gap-e5",
                "projectId":"project-1"
            },
            "outcomeClass":"PROVEN_PARTIAL","requestedBusinessEffect":true,
            "businessOutcome":"PROVEN_SUCCESS","requestedManuscriptEffects":["primary"],
            "settledEffectCount":1,"businessReceipt":business_receipt,
            "manuscriptReceipts":[],
            "manuscriptOutcomes":[{
                "effectResultId":"result-e5-output-gap:manuscript:primary","channel":"primary",
                "outcome":"PROVEN_NO_EFFECT_FAILURE","receipt":null,
                "failureCode":"TEST_WRITER_NOT_INVOKED",
                "failureMessage":"Injected before writer invocation."
            }]
        });
        let settlement = SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: "result-e5-output-gap".into(),
            authorization_id: "authorization-e5-output-gap".into(),
            effect_receipt: receipt.clone(),
            settled_at: "2026-08-28T16:10:05.000Z".into(),
        };
        let pending = read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID)
            .expect("pending E5 parent must remain readable before settlement");
        let pending_result = pending
            .standard_results
            .iter()
            .find(|value| value.id == "result-e5-output-gap")
            .expect("pending E5 parent must be present");
        assert!(
            lp14_a1_c4_parent_settlement_matches(
                pending_result,
                "authorization-e5-output-gap",
                &receipt,
            ),
            "E5 aggregate fixture must match the exact durable parent before settlement: current={pending_result:?} receipt={receipt}"
        );
        let confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &settlement,
        )
        .expect("validated E5 aggregate status and receipt must commit together");
        assert_eq!(confirmed.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(confirmed.standard_results[0].effect_receipt.as_ref(), Some(&receipt));
        settle_ai_standard_result_effect_in_connection(&mut connection, &settlement)
            .expect("exact settlement replay is idempotent");
        drop(connection);

        let reopened = Connection::open(&path).unwrap();
        let readback = read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(readback.standard_results[0].effect_receipt.as_ref(), Some(&receipt));
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup E5 database");
    }

    fn quick_analysis_constraint_source_ref() -> serde_json::Value {
        serde_json::json!({
            "module": "ai",
            "entityType": "system",
            "entityId": "labpod.ai.constraint.quick_analysis",
            "field": "constraintDescriptor",
            "sourceKind": "systemGenerated",
            "constraintCategory": "QUICK_ANALYSIS",
            "constraintLifecycle": "ACTIVE",
            "constraintRef": "labpod.ai.constraint.quick_analysis",
            "constraintVersion": 2,
            "sharedInvariantRef": "labpod.ai.constraint.shared_invariant",
            "sharedInvariantVersion": 2,
            "boundedPolicyRefs": []
        })
    }

    fn literature_outline_quick_run_authorization_source_ref() -> serde_json::Value {
        serde_json::json!({
            "module": "ai",
            "entityType": "system",
            "entityId": "quick-analysis-run-e1-a7",
            "field": "quickAnalysisRunAuthorization",
            "sourceKind": "systemGenerated",
            "isVerified": true,
            "quickAnalysisRunId": "quick-analysis-run-e1-a7",
            "quickAnalysisAuthorizationSource": "USER_CLICKED_AI_ANALYSIS",
            "quickAnalysisOwnerType": "literature",
            "quickAnalysisOwnerId": "literature-e1-a7",
            "quickAnalysisChannel": "literature_outline",
            "quickAnalysisProjectId": "project-e1-a7",
            "quickAnalysisSourceFileRefId": "file-ref-e1-a7-outline",
            "quickAnalysisSourceDirectoryFileRefId": "file-ref-e1-a7-folder",
            "quickAnalysisWhitelistFingerprint": "whitelist-e1-a7-outline",
            "quickAnalysisAutoContextBudgetLimit": 1,
            "quickAnalysisAutoContextBudgetRemaining": 1,
            "quickAnalysisContextCapabilityState": "CONTEXT_ALLOWED"
        })
    }

    fn frozen_constraint_source_ref(context_source_refs: &Value) -> Value {
        context_source_refs
            .as_array()
            .and_then(|refs| refs.iter().find(|value| is_a3_constraint_source_ref(value)))
            .cloned()
            .expect("one frozen constraint source ref")
    }

    fn prepare_input(
        attempt: &str,
        request: &str,
        message: &str,
        at: &str,
    ) -> PrepareAICallAttemptInput {
        PrepareAICallAttemptInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            attempt_id: attempt.into(),
            request_id: request.into(),
            purpose: "chat_response".into(),
            user_message: Some(NewAIMessageInput {
                id: message.into(),
                content: format!("question-{message}"),
                created_at: at.into(),
            }),
            trigger_message_id: None,
            trigger_call_attempt_id: None,
            provider: "deepseek".into(),
            model: "deepseek-v4-flash".into(),
            context_package_id: "context-1".into(),
            context_package_version: "1".into(),
            context_source_refs: serde_json::json!([
                {
                    "module": "project", "entityType": "project", "entityId": "project-1",
                    "sourceKind": "userAuthored"
                },
                normal_qa_constraint_source_ref()
            ]),
            warnings: serde_json::json!([]),
            budget_summary: Some(serde_json::json!({"maxChars": 45000, "usedChars": 120})),
            prompt_package_id: format!("prompt-{request}"),
            prompt_created_at: at.into(),
            started_at: at.into(),
            authorized_file_ref_ids: Vec::new(),
        }
    }

    fn settle_success_input(
        attempt: &str,
        message: &str,
        at: &str,
    ) -> SettleAICallAttemptSuccessInput {
        SettleAICallAttemptSuccessInput {
            attempt_id: attempt.into(),
            provider: "deepseek".into(),
            model: "deepseek-v4-flash".into(),
            response_truncated: Some(false),
            usage: Some(AIUsageInput {
                input_tokens: Some(10),
                output_tokens: Some(20),
                total_tokens: Some(30),
            }),
            assistant_message: Some(NewAIMessageInput {
                id: message.into(),
                content: format!("answer-{message}"),
                created_at: at.into(),
            }),
            context_request: None,
            standard_result_batch: None,
            settled_at: at.into(),
        }
    }

    fn context_request_source(requestable_refs: Value) -> Value {
        serde_json::json!({
            "projectId": "project-1",
            "contextMode": "STANDARD",
            "contextBudget": {
                "maxChars": 12000,
                "reservedForUserQuestion": 0,
                "reservedForSystemInstruction": 0,
                "strategy": "priorityFirst"
            },
            "researchObjects": [{ "objectType": "task", "objectId": "task-1" }],
            "contextReviewFingerprint": "lp13-a5-source-review",
            "requestableRefs": requestable_refs
        })
    }

    fn identity_context_request_candidate() -> Value {
        serde_json::json!({
            "refKind": "AI_RESEARCH_OBJECT",
            "refId": "task-2",
            "entityType": "task",
            "projectId": "project-1",
            "label": "Task Two",
            "contributionKind": "IDENTITY_METADATA",
            "availability": "available",
            "fileBodyAuthorizationRequired": false,
            "proposedContribution": "Task identity for one follow-up call."
        })
    }

    fn file_body_context_request_candidate(file_ref_id: &str) -> Value {
        serde_json::json!({
            "refKind": "FILE_REF",
            "refId": file_ref_id,
            "entityType": "fileRef",
            "projectId": "project-1",
            "label": "context-notes.txt",
            "contributionKind": "BODY_CONTENT",
            "availability": "available",
            "fileBodyAuthorizationRequired": true,
            "proposedContribution": "Authorized bounded text for one follow-up call."
        })
    }

    fn context_request_success_input(
        attempt: &str,
        assistant_message: &str,
        request_id: &str,
        requested_refs: Value,
        reviewed_candidates: Value,
        requestable_refs: Value,
        at: &str,
    ) -> SettleAICallAttemptSuccessInput {
        let mut input = settle_success_input(attempt, assistant_message, at);
        input.context_request = Some(NewAIContextRequestInput {
            id: request_id.into(),
            source: context_request_source(requestable_refs),
            reason: "More canonical context is required for a reliable answer.".into(),
            requested_refs,
            reviewed_candidates,
            initial_state: "PENDING".into(),
            invalid_reason: None,
            created_at: at.into(),
        });
        input
    }

    fn context_request_constraint_source_ref() -> Value {
        let mut source_ref = normal_qa_constraint_source_ref();
        source_ref
            .as_object_mut()
            .expect("constraint source object")
            .insert(
                "boundedPolicyDocuments".into(),
                serde_json::json!([{
                    "documentId": "labpod.ai.policy.context_request",
                    "semanticVersion": 3
                }]),
            );
        source_ref
    }

    fn context_request_followup_input(
        context_request_id: &str,
        action_message_id: &str,
        attempt_id: &str,
        reviewed_candidates: Value,
        authorized_file_ref_ids: Vec<String>,
        at: &str,
    ) -> PrepareAIContextRequestFollowupInput {
        PrepareAIContextRequestFollowupInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            context_request_id: context_request_id.into(),
            action_message_id: action_message_id.into(),
            attempt_id: attempt_id.into(),
            request_id: attempt_id.into(),
            purpose: "chat_response".into(),
            provider: "deepseek".into(),
            model: "deepseek-v4-flash".into(),
            context_package_id: format!("context-{attempt_id}"),
            context_package_version: "ai-lp13-b1-a2-v1".into(),
            context_source_refs: serde_json::json!([
                {
                    "module": "project", "entityType": "project", "entityId": "project-1",
                    "sourceKind": "userAuthored"
                },
                context_request_constraint_source_ref()
            ]),
            warnings: serde_json::json!([]),
            budget_summary: Some(serde_json::json!({"maxChars": 12000, "usedChars": 8000})),
            prompt_package_id: format!("prompt-{attempt_id}"),
            prompt_created_at: at.into(),
            expected_reviewed_candidates: reviewed_candidates.clone(),
            approved_refs: reviewed_candidates,
            started_at: at.into(),
            authorized_file_ref_ids,
        }
    }

    fn settle_failure_input(
        attempt: &str,
        code: &str,
        at: &str,
    ) -> SettleAICallAttemptFailureInput {
        SettleAICallAttemptFailureInput {
            attempt_id: attempt.into(),
            error_code: code.into(),
            error_message: Some(format!("safe-{code}")),
            error_retryable: true,
            provider_status: None,
            settled_at: at.into(),
        }
    }

    fn retry_regenerate_input(
        attempt: &str,
        action_intent: AIChatAttemptActionIntent,
        trigger_message: &str,
        source_attempt: &str,
        effective_message: Option<&str>,
        at: &str,
    ) -> PrepareAIRetryRegenerateAttemptInput {
        PrepareAIRetryRegenerateAttemptInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            attempt_id: attempt.into(),
            request_id: attempt.into(),
            action_intent,
            trigger_message_id: trigger_message.into(),
            expected_source_attempt_id: source_attempt.into(),
            expected_effective_message_id: effective_message.map(str::to_string),
            provider: "deepseek".into(),
            model: "deepseek-v4-flash".into(),
            context_package_id: format!("context-{attempt}"),
            context_package_version: "1".into(),
            context_source_refs: serde_json::json!([
                {
                    "module": "project", "entityType": "project", "entityId": "project-b8",
                    "sourceKind": "userAuthored"
                },
                normal_qa_constraint_source_ref()
            ]),
            warnings: serde_json::json!([]),
            budget_summary: Some(serde_json::json!({"maxChars": 45000, "usedChars": 160})),
            prompt_package_id: format!("prompt-{attempt}"),
            prompt_created_at: at.into(),
            started_at: at.into(),
        }
    }

    fn open_current_database(path: &PathBuf) -> Connection {
        super::super::initialize_test_database_at(path).expect("initialize current database");
        let connection = Connection::open(path).expect("open database");
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("foreign keys");
        create_ai_conversation_in_connection(
            &connection,
            &CreateAIConversationInput {
                id: CURRENT_CONVERSATION_ID.into(),
                stable_key: CURRENT_CONVERSATION_KEY.into(),
                created_at: "2026-08-13T00:00:00.000Z".into(),
            },
        )
        .expect("create test conversation");
        connection
    }

    fn seed_file_ref(
        connection: &Connection,
        database_path: &PathBuf,
        id: &str,
        resource_kind: &str,
        create_resource: bool,
        title: &str,
    ) -> PathBuf {
        let resource_path = database_path
            .parent()
            .expect("database parent")
            .join(format!("{id}.dat"));
        if create_resource {
            if resource_kind == "folder" {
                std::fs::create_dir_all(&resource_path).expect("create task-local folder");
            } else {
                std::fs::write(&resource_path, b"task-local fixture")
                    .expect("create task-local file");
            }
        }
        let path_text = resource_path.to_string_lossy().to_string();
        connection
            .execute(
                "INSERT INTO file_refs(
                   id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                   location_mode,file_type,path,path_identity_key,title,created_at,updated_at
                 ) VALUES (?1,'review','review-b6','primary',?2,'attachment','external',
                           'attachment',?3,?3,?4,'2026-08-14T00:00:00.000Z',
                           '2026-08-14T00:00:00.000Z')",
                params![id, resource_kind, path_text, title],
            )
            .expect("seed canonical FileRef");
        resource_path
    }

    fn seed_quick_manuscript_file_ref(
        connection: &Connection,
        database_path: &PathBuf,
        id: &str,
        owner_type: &str,
        owner_id: &str,
        channel: &str,
        content: &str,
    ) -> PathBuf {
        let resource_path = database_path
            .parent()
            .expect("database parent")
            .join(format!("{id}.md"));
        std::fs::write(&resource_path, content.as_bytes())
            .expect("create task-local Quick manuscript");
        let path_text = resource_path.to_string_lossy().to_string();
        connection
            .execute(
                "INSERT INTO file_refs(
                   id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                   location_mode,file_type,path,path_identity_key,title,created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,'file','manuscript','external',
                           'markdown',?5,?5,?6,'2026-08-20T00:00:00.000Z',
                           '2026-08-20T00:00:00.000Z')",
                params![
                    id,
                    owner_type,
                    owner_id,
                    channel,
                    path_text,
                    format!("{id}.md")
                ],
            )
            .expect("seed canonical Quick manuscript FileRef");
        resource_path
    }

    fn a4_quick_run_authorization_source_ref(
        label: &str,
        source_file_ref_id: &str,
        project_id: &str,
        remaining: u64,
    ) -> Value {
        serde_json::json!({
            "module": "ai",
            "entityType": "system",
            "entityId": format!("quick-analysis-run-{label}"),
            "field": "quickAnalysisRunAuthorization",
            "sourceKind": "systemGenerated",
            "isVerified": true,
            "quickAnalysisRunId": format!("quick-analysis-run-{label}"),
            "quickAnalysisAuthorizationSource": if remaining == 1 {
                "USER_CLICKED_AI_ANALYSIS"
            } else {
                "DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION"
            },
            "quickAnalysisOwnerType": "experiment",
            "quickAnalysisOwnerId": "experiment-e1-a4",
            "quickAnalysisChannel": "primary",
            "quickAnalysisProjectId": project_id,
            "quickAnalysisSourceFileRefId": source_file_ref_id,
            "quickAnalysisSourceDirectoryFileRefId": "folder-e1-a4",
            "quickAnalysisWhitelistFingerprint": format!("whitelist-{label}"),
            "quickAnalysisAutoContextBudgetLimit": 1,
            "quickAnalysisAutoContextBudgetRemaining": remaining,
            "quickAnalysisContextCapabilityState": if remaining == 1 {
                "CONTEXT_ALLOWED"
            } else {
                "CONTEXT_EXHAUSTED"
            }
        })
    }

    fn a4_quick_constraint_source_ref(include_context_request: bool) -> Value {
        let mut value = quick_analysis_constraint_source_ref();
        if include_context_request {
            value
                .as_object_mut()
                .expect("Quick constraint object")
                .insert(
                    "boundedPolicyDocuments".into(),
                    serde_json::json!([{
                        "documentId": "labpod.ai.policy.context_request",
                        "semanticVersion": 2
                    }]),
                );
        }
        value
    }

    fn a4_body_receipt_entry(
        file_ref_id: &str,
        source_path: &std::path::Path,
        origins: &[&str],
        context_request_id: &str,
    ) -> Value {
        let freshness = crate::authorized_material::inspect_material_freshness_receipt(
            source_path,
            file_ref_id,
        )
        .expect("fresh Quick manuscript receipt");
        serde_json::json!({
            "fileRefId": file_ref_id,
            "materialUse": "BODY_CONTENT",
            "authorizationOrigins": origins,
            "projectId": "project-1",
            "ownerType": "experiment",
            "ownerId": "experiment-e1-a4",
            "channel": "primary",
            "sourceFreshnessIdentity": freshness,
            "contextRequestIds": if origins.contains(&"CONTEXT_REQUEST_APPROVAL") {
                vec![context_request_id]
            } else {
                Vec::<&str>::new()
            }
        })
    }

    fn a4_quick_followup_source_refs(
        label: &str,
        source_file_ref_id: &str,
        context_request_id: &str,
        project_id: &str,
        body_entries: Vec<Value>,
        metadata_entries: Vec<Value>,
    ) -> Value {
        serde_json::json!([
            a4_quick_constraint_source_ref(false),
            a4_quick_run_authorization_source_ref(
                label,
                source_file_ref_id,
                project_id,
                0
            ),
            {
                "module": "ai",
                "entityType": "system",
                "entityId": context_request_id,
                "label": "Quick Analysis Context follow-up authorization",
                "field": "quickAnalysisContextFollowupAuthorization",
                "sourceKind": "systemGenerated",
                "isUserAuthored": false,
                "isAiGenerated": false,
                "isVerified": true,
                "quickAnalysisRunId": format!("quick-analysis-run-{label}"),
                "quickAnalysisProjectId": project_id,
                "quickAnalysisOwnerType": "experiment",
                "quickAnalysisOwnerId": "experiment-e1-a4",
                "quickAnalysisChannel": "primary",
                "quickAnalysisFollowupContextRequestId": context_request_id,
                "quickAnalysisFollowupBodyAuthorizationEntries": body_entries,
                "quickAnalysisFollowupMetadataReferenceEntries": metadata_entries
            }
        ])
    }

    fn a4_prepare_pending_quick_context_request(
        label: &str,
        reviewed_candidates: Value,
        requested_refs: Value,
        requestable_refs: Value,
        supplemental_file_ref_ids: &[&str],
    ) -> (PathBuf, Connection, PathBuf, Vec<PathBuf>) {
        let path = temporary_database_path(label);
        let mut connection = open_current_database(&path);
        let source_file_ref_id = format!("file-ref-{label}-source");
        let source_path = seed_quick_manuscript_file_ref(
            &connection,
            &path,
            &source_file_ref_id,
            "experiment",
            "experiment-e1-a4",
            "primary",
            "LP13-E1-A4 frozen Quick source sentinel",
        );
        let supplemental_paths = supplemental_file_ref_ids
            .iter()
            .map(|file_ref_id| {
                seed_quick_manuscript_file_ref(
                    &connection,
                    &path,
                    file_ref_id,
                    "experiment",
                    "experiment-e1-a4",
                    "primary",
                    &format!("LP13-E1-A4 supplemental sentinel {file_ref_id}"),
                )
            })
            .collect::<Vec<_>>();
        let mut source_prepare = prepare_input(
            &format!("attempt-{label}-source"),
            &format!("attempt-{label}-source"),
            &format!("message-{label}-user"),
            "2026-08-20T12:00:00.000Z",
        );
        source_prepare.context_source_refs = serde_json::json!([
            a4_quick_constraint_source_ref(true),
            a4_quick_run_authorization_source_ref(label, &source_file_ref_id, "project-1", 1)
        ]);
        source_prepare.authorized_file_ref_ids = vec![source_file_ref_id];
        prepare_ai_call_attempt_in_connection(&mut connection, &source_prepare)
            .expect("prepare frozen Quick source attempt");
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &context_request_success_input(
                &format!("attempt-{label}-source"),
                &format!("message-{label}-source-assistant"),
                &format!("context-request-{label}"),
                requested_refs,
                reviewed_candidates,
                requestable_refs,
                "2026-08-20T12:00:01.000Z",
            ),
        )
        .expect("settle canonical pending Quick Context Request");
        (path, connection, source_path, supplemental_paths)
    }

    #[test]
    fn lp13_e1_a4_d1_d5_d8_d10_d11_d13_frozen_metadata_only_is_exact_and_resumable() {
        let label = "e1-a4-d1";
        let request_id = format!("context-request-{label}");
        let source_file_ref_id = format!("file-ref-{label}-source");
        let metadata_candidate = identity_context_request_candidate();
        let (path, mut connection, source_path, _) = a4_prepare_pending_quick_context_request(
            label,
            serde_json::json!([metadata_candidate.clone()]),
            serde_json::json!([{
                "refKind": "AI_RESEARCH_OBJECT",
                "refId": "task-2",
                "contributionKind": "IDENTITY_METADATA"
            }]),
            serde_json::json!([{
                "refKind": "AI_RESEARCH_OBJECT",
                "refId": "task-2",
                "projectId": "project-1",
                "label": "Task Two",
                "entityType": "task",
                "allowedContributionKinds": ["IDENTITY_METADATA"]
            }]),
            &[],
        );
        let body_entries = vec![a4_body_receipt_entry(
            &source_file_ref_id,
            &source_path,
            &["RUN_SCOPED_FROZEN_SOURCE"],
            &request_id,
        )];
        let metadata_entries = vec![serde_json::json!({
            "refKind": "AI_RESEARCH_OBJECT",
            "refId": "task-2",
            "contributionKind": "IDENTITY_METADATA",
            "projectId": "project-1",
            "contextRequestId": request_id
        })];
        let mut valid = context_request_followup_input(
            &request_id,
            "message-e1-a4-d1-approve",
            "attempt-e1-a4-d1-followup",
            serde_json::json!([metadata_candidate]),
            vec![source_file_ref_id.clone()],
            "2026-08-20T12:00:02.000Z",
        );
        valid.context_source_refs = a4_quick_followup_source_refs(
            label,
            &source_file_ref_id,
            &request_id,
            "project-1",
            body_entries,
            metadata_entries,
        );

        let mut unauthorized_extra = valid.clone();
        unauthorized_extra.action_message_id = "message-e1-a4-d1-extra".into();
        unauthorized_extra.attempt_id = "attempt-e1-a4-d1-extra".into();
        unauthorized_extra.request_id = unauthorized_extra.attempt_id.clone();
        unauthorized_extra
            .authorized_file_ref_ids
            .push("file-ref-unauthorized-extra".into());
        let extra_error =
            prepare_ai_context_request_followup_in_connection(&mut connection, &unauthorized_extra)
                .expect_err("D5 unauthorized BODY extras must fail before mutation");
        assert!(extra_error.contains("AI_CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED"));

        let mut wrong_project = valid.clone();
        wrong_project.action_message_id = "message-e1-a4-d1-wrong-project".into();
        wrong_project.attempt_id = "attempt-e1-a4-d1-wrong-project".into();
        wrong_project.request_id = wrong_project.attempt_id.clone();
        wrong_project.context_source_refs[1]["quickAnalysisProjectId"] =
            serde_json::json!("project-other");
        wrong_project.context_source_refs[2]["quickAnalysisProjectId"] =
            serde_json::json!("project-other");
        let project_error =
            prepare_ai_context_request_followup_in_connection(&mut connection, &wrong_project)
                .expect_err("D6 cross-Project Quick scope must fail before mutation");
        assert!(project_error.contains("AI_CONTEXT_REQUEST_SOURCE_STALE"));

        let mut stale = valid.clone();
        stale.action_message_id = "message-e1-a4-d1-stale".into();
        stale.attempt_id = "attempt-e1-a4-d1-stale".into();
        stale.request_id = stale.attempt_id.clone();
        stale.context_source_refs[2]["quickAnalysisFollowupBodyAuthorizationEntries"][0]
            ["sourceFreshnessIdentity"]["sourceToken"] = serde_json::json!("0".repeat(64));
        let stale_error =
            prepare_ai_context_request_followup_in_connection(&mut connection, &stale)
                .expect_err("D7 stale BODY freshness must fail before mutation");
        assert!(stale_error.contains("AI_CONTEXT_REQUEST_SOURCE_STALE"));

        let after_failures =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(after_failures.context_requests[0].state, "PENDING");
        assert_eq!(after_failures.call_attempts.len(), 1);
        assert_eq!(
            after_failures
                .messages
                .iter()
                .filter(|message| message.message_kind == "context_request_action")
                .count(),
            0
        );

        let prepared = prepare_ai_context_request_followup_in_connection(&mut connection, &valid)
            .expect("D11/D13 same PENDING request remains canonically resumable");
        assert!(prepared.provider_invocation_authorized);
        assert_eq!(prepared.readback.context_requests[0].state, "APPROVED");
        assert_eq!(prepared.readback.call_attempts.len(), 2);
        assert_eq!(
            prepared.readback.call_attempts[1]
                .authorized_file_refs
                .len(),
            1
        );
        assert_eq!(
            prepared.readback.call_attempts[1].authorized_file_refs[0].file_ref_id,
            source_file_ref_id
        );
        let selection = read_authorized_material_selection_in_connection(
            &connection,
            "attempt-e1-a4-d1-followup",
            CURRENT_CONVERSATION_ID,
            "message-e1-a4-d1-approve",
        )
        .expect("D10 canonical Provider material selection");
        assert!(selection.context_request_followup);
        assert_eq!(selection.files.len(), 1);
        let receipt = crate::authorized_material::quick_followup_authorization_receipt(
            &selection.context_source_refs,
        )
        .expect("typed receipt parse")
        .expect("typed receipt exists");
        assert_eq!(receipt.body_entries.len(), selection.files.len());
        assert_eq!(
            receipt.body_entries[0].file_ref_id,
            selection.files[0].file_ref_id
        );
        assert_eq!(receipt.metadata_entries.len(), 1);
        assert_eq!(
            selection
                .files
                .iter()
                .filter(|file| file.file_ref_id == "task-2")
                .count(),
            0,
            "D1/D8 metadata-only references never become BODY material"
        );

        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp13_e1_a4_d2_d3_d4_frozen_and_supplemental_body_union_is_canonical() {
        let label = "e1-a4-d2";
        let request_id = format!("context-request-{label}");
        let source_file_ref_id = format!("file-ref-{label}-source");
        let supplemental_file_ref_id = "file-ref-e1-a4-d2-supplement";
        let supplemental_candidate = file_body_context_request_candidate(supplemental_file_ref_id);
        let (path, mut connection, source_path, supplemental_paths) =
            a4_prepare_pending_quick_context_request(
                label,
                serde_json::json!([supplemental_candidate.clone()]),
                serde_json::json!([{
                    "refKind": "FILE_REF",
                    "refId": supplemental_file_ref_id,
                    "contributionKind": "BODY_CONTENT"
                }]),
                serde_json::json!([{
                    "refKind": "FILE_REF",
                    "refId": supplemental_file_ref_id,
                    "projectId": "project-1",
                    "label": "Supplemental manuscript",
                    "entityType": "fileRef",
                    "allowedContributionKinds": ["IDENTITY_METADATA", "BODY_CONTENT"]
                }]),
                &[supplemental_file_ref_id],
            );
        let supplemental_path = &supplemental_paths[0];
        let mut followup = context_request_followup_input(
            &request_id,
            "message-e1-a4-d2-approve",
            "attempt-e1-a4-d2-followup",
            serde_json::json!([supplemental_candidate]),
            vec![source_file_ref_id.clone(), supplemental_file_ref_id.into()],
            "2026-08-20T12:00:02.000Z",
        );
        let mut entries = vec![
            a4_body_receipt_entry(
                &source_file_ref_id,
                &source_path,
                &["RUN_SCOPED_FROZEN_SOURCE"],
                &request_id,
            ),
            a4_body_receipt_entry(
                supplemental_file_ref_id,
                supplemental_path,
                &["CONTEXT_REQUEST_APPROVAL"],
                &request_id,
            ),
        ];
        entries.sort_by(|left, right| left["fileRefId"].as_str().cmp(&right["fileRefId"].as_str()));
        followup.context_source_refs = a4_quick_followup_source_refs(
            label,
            &source_file_ref_id,
            &request_id,
            "project-1",
            entries,
            Vec::new(),
        );
        let prepared =
            prepare_ai_context_request_followup_in_connection(&mut connection, &followup)
                .expect("D2/D3 frozen source plus one approved manuscript BODY");
        let authorized = prepared.readback.call_attempts[1]
            .authorized_file_refs
            .iter()
            .map(|file| file.file_ref_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            authorized,
            vec![source_file_ref_id.as_str(), supplemental_file_ref_id]
        );
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");

        let duplicate_label = "e1-a4-d4";
        let duplicate_request_id = format!("context-request-{duplicate_label}");
        let duplicate_source_id = format!("file-ref-{duplicate_label}-source");
        let duplicate_candidate = file_body_context_request_candidate(&duplicate_source_id);
        let (duplicate_path, mut duplicate_connection, duplicate_source_path, _) =
            a4_prepare_pending_quick_context_request(
                duplicate_label,
                serde_json::json!([duplicate_candidate.clone()]),
                serde_json::json!([{
                    "refKind": "FILE_REF",
                    "refId": duplicate_source_id,
                    "contributionKind": "BODY_CONTENT"
                }]),
                serde_json::json!([{
                    "refKind": "FILE_REF",
                    "refId": duplicate_source_id,
                    "projectId": "project-1",
                    "label": "Frozen source manuscript",
                    "entityType": "fileRef",
                    "allowedContributionKinds": ["IDENTITY_METADATA", "BODY_CONTENT"]
                }]),
                &[],
            );
        let mut duplicate_followup = context_request_followup_input(
            &duplicate_request_id,
            "message-e1-a4-d4-approve",
            "attempt-e1-a4-d4-followup",
            serde_json::json!([duplicate_candidate]),
            vec![duplicate_source_id.clone()],
            "2026-08-20T12:01:02.000Z",
        );
        duplicate_followup.context_source_refs = a4_quick_followup_source_refs(
            duplicate_label,
            &duplicate_source_id,
            &duplicate_request_id,
            "project-1",
            vec![a4_body_receipt_entry(
                &duplicate_source_id,
                &duplicate_source_path,
                &["RUN_SCOPED_FROZEN_SOURCE", "CONTEXT_REQUEST_APPROVAL"],
                &duplicate_request_id,
            )],
            Vec::new(),
        );
        let duplicate_prepared = prepare_ai_context_request_followup_in_connection(
            &mut duplicate_connection,
            &duplicate_followup,
        )
        .expect("D4 duplicate BODY identity is one authorization with both origins");
        assert_eq!(
            duplicate_prepared.readback.call_attempts[1]
                .authorized_file_refs
                .len(),
            1
        );
        let receipt = crate::authorized_material::quick_followup_authorization_receipt(
            &duplicate_prepared.readback.call_attempts[1].context_source_refs,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            receipt.body_entries[0].authorization_origins,
            vec![
                "RUN_SCOPED_FROZEN_SOURCE".to_string(),
                "CONTEXT_REQUEST_APPROVAL".to_string()
            ]
        );
        drop(duplicate_connection);
        std::fs::remove_dir_all(duplicate_path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp13_e1_a4_d12_concurrent_duplicate_approval_has_one_conflict_safe_winner() {
        let label = "e1-a4-d12";
        let request_id = format!("context-request-{label}");
        let source_file_ref_id = format!("file-ref-{label}-source");
        let metadata_candidate = identity_context_request_candidate();
        let (path, connection, source_path, _) = a4_prepare_pending_quick_context_request(
            label,
            serde_json::json!([metadata_candidate.clone()]),
            serde_json::json!([{
                "refKind": "AI_RESEARCH_OBJECT",
                "refId": "task-2",
                "contributionKind": "IDENTITY_METADATA"
            }]),
            serde_json::json!([{
                "refKind": "AI_RESEARCH_OBJECT",
                "refId": "task-2",
                "projectId": "project-1",
                "label": "Task Two",
                "entityType": "task",
                "allowedContributionKinds": ["IDENTITY_METADATA"]
            }]),
            &[],
        );
        let source_refs = a4_quick_followup_source_refs(
            label,
            &source_file_ref_id,
            &request_id,
            "project-1",
            vec![a4_body_receipt_entry(
                &source_file_ref_id,
                &source_path,
                &["RUN_SCOPED_FROZEN_SOURCE"],
                &request_id,
            )],
            vec![serde_json::json!({
                "refKind": "AI_RESEARCH_OBJECT",
                "refId": "task-2",
                "contributionKind": "IDENTITY_METADATA",
                "projectId": "project-1",
                "contextRequestId": request_id
            })],
        );
        let build_input = |suffix: &str| {
            let mut input = context_request_followup_input(
                &request_id,
                &format!("message-e1-a4-d12-{suffix}"),
                &format!("attempt-e1-a4-d12-{suffix}"),
                serde_json::json!([metadata_candidate.clone()]),
                vec![source_file_ref_id.clone()],
                "2026-08-20T12:02:02.000Z",
            );
            input.context_source_refs = source_refs.clone();
            input
        };
        let inputs = [build_input("winner-a"), build_input("winner-b")];
        drop(connection);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let handles = inputs
            .into_iter()
            .map(|input| {
                let database_path = path.clone();
                let thread_barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let mut connection = Connection::open(database_path).expect("race connection");
                    connection
                        .busy_timeout(std::time::Duration::from_secs(5))
                        .expect("race busy timeout");
                    connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
                    thread_barrier.wait();
                    prepare_ai_context_request_followup_in_connection(&mut connection, &input)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("approval race thread"))
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.contains("AI_CONTEXT_REQUEST_TERMINAL_CONFLICT")));
        let read_connection = Connection::open(&path).expect("post-race readback");
        let readback =
            read_ai_conversation_in_connection(&read_connection, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.context_requests[0].state, "APPROVED");
        assert_eq!(readback.call_attempts.len(), 2);
        assert_eq!(
            readback
                .messages
                .iter()
                .filter(|message| message.message_kind == "context_request_action")
                .count(),
            1
        );
        drop(read_connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }


    #[test]
    fn fresh_and_v54_upgrade_create_exact_ai_and_attachment_foundations() {
        let fresh_path = temporary_database_path("fresh-migration");
        let fresh = open_current_database(&fresh_path);
        assert!(schema_is_current(&fresh).expect("schema validation"));
        super::super::schema::run_migrations(&fresh).expect("repeat current migration safely");
        assert!(schema_is_current(&fresh).expect("repeated schema validation"));
        let version: i64 = fresh
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, super::super::schema::CURRENT_SCHEMA_VERSION);
        drop(fresh);

        let upgrade_path = temporary_database_path("v54-upgrade");
        let upgrade = open_current_database(&upgrade_path);
        upgrade
            .execute_batch(
                "DROP TABLE ai_standard_results;
                 DROP TABLE ai_context_requests;
                 DROP TABLE ai_call_attempt_file_ref_authorizations;
                 DROP TABLE ai_call_attempts;
                 DROP TABLE ai_messages;
                 DROP TABLE ai_conversations;
                 DELETE FROM schema_migrations WHERE version=58;
                 DELETE FROM schema_migrations WHERE version=57;
                 DELETE FROM schema_migrations WHERE version=56;
                 DELETE FROM schema_migrations WHERE version=55;
                 PRAGMA user_version=54;",
            )
            .expect("construct v54 fixture");
        super::super::schema::run_migrations(&upgrade).expect("upgrade v54 through v57");
        assert!(schema_is_current(&upgrade).expect("upgraded schema validation"));
        drop(upgrade);

        for path in [fresh_path, upgrade_path] {
            let parent = path.parent().expect("database parent");
            std::fs::remove_dir_all(parent).expect("cleanup database");
        }
    }

    #[test]
    fn ensure_and_request_replay_are_idempotent_and_message_order_is_deterministic() {
        let path = temporary_database_path("idempotent-order");
        let mut connection = open_current_database(&path);
        let timestamp = "2026-08-13T12:00:00.000Z";
        let first = prepare_input("attempt-1", "request-1", "message-user-1", timestamp);
        let prepared = prepare_ai_call_attempt_in_connection(&mut connection, &first).unwrap();
        assert!(prepared.provider_invocation_authorized);
        let replay = prepare_ai_call_attempt_in_connection(&mut connection, &first).unwrap();
        assert!(!replay.provider_invocation_authorized);
        let second = prepare_input("attempt-2", "request-2", "message-user-2", timestamp);
        prepare_ai_call_attempt_in_connection(&mut connection, &second).unwrap();
        let readback =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(
            readback
                .messages
                .iter()
                .map(|message| message.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(
            readback
                .call_attempts
                .iter()
                .map(|attempt| attempt.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        let conversation_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM ai_conversations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(conversation_count, 1);
        let conversations = list_ai_conversations_in_connection(&connection).unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].id, CURRENT_CONVERSATION_ID);
        assert_eq!(conversations[0].stable_key, CURRENT_CONVERSATION_KEY);
        let orphan_error = connection
            .execute(
                "INSERT INTO ai_messages(id,conversation_id,sequence,role,content,created_at)
                 VALUES ('orphan-message','missing-conversation',99,'user','orphan',
                         '2026-08-13T12:00:00.000Z')",
                [],
            )
            .expect_err("message foreign key must reject an orphan conversation");
        assert!(orphan_error
            .to_string()
            .contains("FOREIGN KEY constraint failed"));
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp13_d1_a6_quick_analysis_constraint_provenance_is_durable_and_restart_readable() {
        let path = temporary_database_path("d1-a6-quick-analysis-provenance");
        let mut connection = open_current_database(&path);
        let mut input = prepare_input(
            "attempt-quick-a6",
            "request-quick-a6",
            "message-quick-a6",
            "2026-08-18T12:00:00.000Z",
        );
        input.context_source_refs = serde_json::json!([
            {
                "module": "project",
                "entityType": "project",
                "entityId": "project-a6",
                "sourceKind": "userAuthored"
            },
            quick_analysis_constraint_source_ref()
        ]);
        prepare_ai_call_attempt_in_connection(&mut connection, &input)
            .expect("prepare active Quick Analysis attempt");
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-quick-a6",
                "message-assistant-quick-a6",
                "2026-08-18T12:00:01.000Z",
            ),
        )
        .expect("settle Quick Analysis attempt");
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.call_attempts.len(), 1);
        assert_eq!(readback.call_attempts[0].purpose, "chat_response");
        assert_eq!(readback.call_attempts[0].status, "succeeded");
        let descriptor = frozen_constraint_source_ref(
            &readback.call_attempts[0].context_source_refs,
        );
        assert_eq!(
            descriptor.get("constraintCategory").and_then(Value::as_str),
            Some("QUICK_ANALYSIS")
        );
        assert_eq!(
            descriptor.get("constraintRef").and_then(Value::as_str),
            Some("labpod.ai.constraint.quick_analysis")
        );
        assert_eq!(
            descriptor.get("constraintVersion").and_then(Value::as_u64),
            Some(2)
        );
        assert_eq!(
            descriptor
                .get("sharedInvariantVersion")
                .and_then(Value::as_u64),
            Some(2)
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp13_e1_a5_legacy_quick_v2_provenance_remains_readable_but_v1_is_rejected() {
        let current = serde_json::json!([quick_analysis_constraint_source_ref()]);
        validate_a3_constraint_source_refs(&current, "chat_response")
            .expect("historical Quick Analysis v2 plus shared invariant v2 must remain readable");

        let mut stale = quick_analysis_constraint_source_ref();
        stale["constraintVersion"] = serde_json::json!(1);
        let error = validate_a3_constraint_source_refs(
            &serde_json::json!([stale]),
            "chat_response",
        )
        .expect_err("retired Quick Analysis v1 provenance must fail closed for new prepares");
        assert!(error.contains("AI_CONSTRAINT_PROVENANCE_INVALID"));

        let mut historical_shared = quick_analysis_constraint_source_ref();
        historical_shared["sharedInvariantVersion"] = serde_json::json!(1);
        let shared_error = validate_a3_constraint_source_refs(
            &serde_json::json!([historical_shared]),
            "chat_response",
        )
        .expect_err("historical shared invariant v1 must fail closed for new prepares");
        assert!(shared_error.contains("AI_CONSTRAINT_PROVENANCE_INVALID"));
    }

    #[test]
    fn lp14_a1_f14_context_request_v3_predecessor_and_v4_successor_provenance_are_readable() {
        let predecessor = context_request_constraint_source_ref();
        validate_a3_constraint_source_refs(
            &serde_json::json!([predecessor]),
            "chat_response",
        )
        .expect("immutable Context Request policy v3 provenance remains readable");

        let mut successor = context_request_constraint_source_ref();
        successor["boundedPolicyDocuments"][0]["semanticVersion"] = serde_json::json!(4);
        validate_a3_constraint_source_refs(
            &serde_json::json!([successor]),
            "chat_response",
        )
        .expect("current Context Request policy v4 provenance reaches durable prepare");
    }

    #[test]
    fn lp13_f1_a1_simple_quick_v3_v4_durable_prepare_target_selection_is_exact() {
        let mut general = quick_analysis_constraint_source_ref();
        general["constraintVersion"] = serde_json::json!(3);
        general["constraintContentHash"] = serde_json::json!("fnv1a64:general");
        general["sharedInvariantContentHash"] = serde_json::json!("fnv1a64:shared");
        let mut dedicated_notes = literature_outline_quick_run_authorization_source_ref();
        dedicated_notes["quickAnalysisChannel"] = serde_json::json!("dedicated_notes");
        validate_a3_constraint_source_refs(
            &serde_json::json!([general.clone(), dedicated_notes.clone()]),
            "chat_response",
        )
        .expect("general Quick v3 must reach durable prepare for a non-objective channel");

        let mut objective = quick_analysis_constraint_source_ref();
        objective["constraintVersion"] = serde_json::json!(4);
        objective["constraintContentHash"] = serde_json::json!("fnv1a64:objective");
        objective["sharedInvariantContentHash"] = serde_json::json!("fnv1a64:shared");
        let objective_target = literature_outline_quick_run_authorization_source_ref();
        validate_a3_constraint_source_refs(
            &serde_json::json!([objective.clone(), objective_target.clone()]),
            "chat_response",
        )
        .expect("objective Quick v4 must reach durable prepare for Literature/literature_outline");

        let crossed_general = validate_a3_constraint_source_refs(
            &serde_json::json!([general, objective_target]),
            "chat_response",
        )
        .expect_err("general Quick v3 must not bind Literature/literature_outline");
        assert!(crossed_general.contains("AI_CONSTRAINT_PROVENANCE_INVALID"));

        let crossed_objective = validate_a3_constraint_source_refs(
            &serde_json::json!([objective, dedicated_notes]),
            "chat_response",
        )
        .expect_err("objective Quick v4 must not bind a general Quick channel");
        assert!(crossed_objective.contains("AI_CONSTRAINT_PROVENANCE_INVALID"));
    }

    #[test]
    fn lp13_e1_a7_objective_outline_policy_is_bounded_to_the_exact_literature_quick_target() {
        let mut objective = quick_analysis_constraint_source_ref();
        objective["boundedPolicyDocuments"] = serde_json::json!([{
            "documentId": "labpod.ai.policy.literature_objective_outline",
            "semanticVersion": 1
        }]);
        let current = serde_json::json!([
            objective.clone(),
            literature_outline_quick_run_authorization_source_ref()
        ]);
        validate_a3_constraint_source_refs(&current, "chat_response")
            .expect("the exact Literature outline objective policy must reach durable prepare");

        let mut wrong_channel = literature_outline_quick_run_authorization_source_ref();
        wrong_channel["quickAnalysisChannel"] = serde_json::json!("dedicated_notes");
        let wrong_channel_error = validate_a3_constraint_source_refs(
            &serde_json::json!([objective.clone(), wrong_channel]),
            "chat_response",
        )
        .expect_err("the objective policy must not attach to Literature dedicated notes");
        assert!(wrong_channel_error.contains("AI_CONSTRAINT_PROVENANCE_INVALID"));

        let mut unknown = objective.clone();
        unknown["boundedPolicyDocuments"][0]["documentId"] =
            serde_json::json!("labpod.ai.policy.unknown");
        let unknown_error = validate_a3_constraint_source_refs(
            &serde_json::json!([
                unknown,
                literature_outline_quick_run_authorization_source_ref()
            ]),
            "chat_response",
        )
        .expect_err("unknown bounded policy identities must fail closed");
        assert!(unknown_error.contains("AI_CONSTRAINT_PROVENANCE_INVALID"));

        objective["boundedPolicyDocuments"] = serde_json::json!([
            {
                "documentId": "labpod.ai.policy.literature_objective_outline",
                "semanticVersion": 1
            },
            {
                "documentId": "labpod.ai.policy.context_request",
                "semanticVersion": 3
            }
        ]);
        let multiple_error = validate_a3_constraint_source_refs(
            &serde_json::json!([
                objective,
                literature_outline_quick_run_authorization_source_ref()
            ]),
            "chat_response",
        )
        .expect_err("a descriptor must not carry two bounded policy documents");
        assert!(multiple_error.contains("AI_CONSTRAINT_PROVENANCE_INVALID"));
    }

    #[test]
    fn lp13_e1_a11_parse_semantic_correction_provenance_is_parse_draft_only() {
        let mut correction = quick_analysis_constraint_source_ref();
        correction["constraintCategory"] = serde_json::json!("PARSE_DRAFT");
        correction["constraintRef"] = serde_json::json!("labpod.ai.constraint.parse_draft");
        correction["constraintVersion"] = serde_json::json!(4);
        correction["boundedPolicyDocuments"] = serde_json::json!([{
            "documentId": "labpod.ai.policy.parse_semantic_correction",
            "semanticVersion": 1
        }]);
        validate_a3_constraint_source_refs(
            &serde_json::json!([correction.clone()]),
            "parse_draft",
        )
        .expect("the exact A11 correction policy must reach durable Parse prepare");

        let error = validate_a3_constraint_source_refs(
            &serde_json::json!([correction]),
            "chat_response",
        )
        .expect_err("the A11 correction policy must fail closed outside Parse prepare");
        assert!(error.contains("AI_CONSTRAINT_PROVENANCE_INVALID"));
    }

    #[test]
    fn lp14_a1_b11_parse_prepare_accepts_only_the_current_context_request_policy() {
        let current = parse_constraint_source_refs("message-b11-current-policy");
        validate_a3_constraint_source_refs(&current, "parse_draft")
            .expect("the current Context Request policy v2 must reach durable Parse prepare");

        let mut stale = current;
        stale[0]["boundedPolicyDocuments"][0]["semanticVersion"] = serde_json::json!(1);
        let error = validate_a3_constraint_source_refs(&stale, "parse_draft")
            .expect_err("the retired Context Request policy v1 must fail closed");
        assert!(error.contains("AI_CONSTRAINT_PROVENANCE_INVALID"));
    }

    #[test]
    fn success_and_action_draft_attempt_survive_restart_equivalent_readback() {
        let path = temporary_database_path("restart-success");
        let mut connection = open_current_database(&path);
        let started = "2026-08-13T12:00:00.000Z";
        let settled = "2026-08-13T12:00:01.000Z";
        let ordinary = prepare_input("attempt-chat", "request-chat", "message-user", started);
        prepare_ai_call_attempt_in_connection(&mut connection, &ordinary).unwrap();
        let success = settle_success_input("attempt-chat", "message-assistant", settled);
        settle_ai_call_attempt_success_in_connection(&mut connection, &success).unwrap();

        let draft = PrepareAICallAttemptInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            attempt_id: "attempt-draft".into(),
            request_id: "request-draft".into(),
            purpose: "action_draft_generation".into(),
            user_message: None,
            trigger_message_id: Some("message-assistant".into()),
            trigger_call_attempt_id: Some("attempt-chat".into()),
            provider: "deepseek".into(),
            model: "deepseek-v4-flash".into(),
            context_package_id: "context-1".into(),
            context_package_version: "1".into(),
            context_source_refs: serde_json::json!([]),
            warnings: serde_json::json!([]),
            budget_summary: None,
            prompt_package_id: "prompt-draft".into(),
            prompt_created_at: settled.into(),
            started_at: settled.into(),
            authorized_file_ref_ids: Vec::new(),
        };
        prepare_ai_call_attempt_in_connection(&mut connection, &draft).unwrap();
        let draft_success = SettleAICallAttemptSuccessInput {
            attempt_id: "attempt-draft".into(),
            provider: "deepseek".into(),
            model: "deepseek-v4-flash".into(),
            response_truncated: None,
            usage: None,
            assistant_message: None,
            context_request: None,
            standard_result_batch: None,
            settled_at: "2026-08-13T12:00:02.000Z".into(),
        };
        settle_ai_call_attempt_success_in_connection(&mut connection, &draft_success).unwrap();
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.messages.len(), 2);
        assert_eq!(readback.messages[0].role, "user");
        assert_eq!(readback.messages[1].role, "assistant");
        assert_eq!(readback.call_attempts.len(), 2);
        assert_eq!(readback.call_attempts[0].status, "succeeded");
        assert_eq!(
            readback.call_attempts[0].result_message_id.as_deref(),
            Some("message-assistant")
        );
        assert_eq!(readback.call_attempts[1].purpose, "action_draft_generation");
        assert_eq!(readback.call_attempts[1].result_message_id, None);
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn action_draft_provider_failure_remains_independent_and_restart_readable() {
        let path = temporary_database_path("action-draft-failure");
        let mut connection = open_current_database(&path);
        let ordinary = prepare_input(
            "attempt-chat-source",
            "request-chat-source",
            "message-user-source",
            "2026-08-13T12:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &ordinary).unwrap();
        let ordinary_success = settle_success_input(
            "attempt-chat-source",
            "message-assistant-source",
            "2026-08-13T12:00:01.000Z",
        );
        settle_ai_call_attempt_success_in_connection(&mut connection, &ordinary_success).unwrap();
        let draft = PrepareAICallAttemptInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            attempt_id: "attempt-draft-failure".into(),
            request_id: "request-draft-failure".into(),
            purpose: "action_draft_generation".into(),
            user_message: None,
            trigger_message_id: Some("message-assistant-source".into()),
            trigger_call_attempt_id: Some("attempt-chat-source".into()),
            provider: "deepseek".into(),
            model: "deepseek-v4-flash".into(),
            context_package_id: "context-1".into(),
            context_package_version: "1".into(),
            context_source_refs: serde_json::json!([]),
            warnings: serde_json::json!([]),
            budget_summary: None,
            prompt_package_id: "prompt-draft-failure".into(),
            prompt_created_at: "2026-08-13T12:00:02.000Z".into(),
            started_at: "2026-08-13T12:00:02.000Z".into(),
            authorized_file_ref_ids: Vec::new(),
        };
        prepare_ai_call_attempt_in_connection(&mut connection, &draft).unwrap();
        let failure = SettleAICallAttemptFailureInput {
            attempt_id: "attempt-draft-failure".into(),
            error_code: "provider_error".into(),
            error_message: Some("provider unavailable".into()),
            error_retryable: true,
            provider_status: Some(503),
            settled_at: "2026-08-13T12:00:03.000Z".into(),
        };
        settle_ai_call_attempt_failure_in_connection(&mut connection, &failure).unwrap();
        drop(connection);

        let reopened = Connection::open(&path).unwrap();
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.messages.len(), 2);
        assert_eq!(readback.call_attempts.len(), 2);
        let draft_attempt = &readback.call_attempts[1];
        assert_eq!(draft_attempt.purpose, "action_draft_generation");
        assert_eq!(draft_attempt.status, "failed");
        assert_eq!(
            draft_attempt.trigger_message_id.as_deref(),
            Some("message-assistant-source")
        );
        assert_eq!(
            draft_attempt.trigger_call_attempt_id.as_deref(),
            Some("attempt-chat-source")
        );
        assert_eq!(draft_attempt.result_message_id, None);
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn provider_failure_is_durable_without_fake_assistant_message() {
        let path = temporary_database_path("provider-failure");
        let mut connection = open_current_database(&path);
        let input = prepare_input(
            "attempt-failure",
            "request-failure",
            "message-user-failure",
            "2026-08-13T12:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &input).unwrap();
        let failure = SettleAICallAttemptFailureInput {
            attempt_id: "attempt-failure".into(),
            error_code: "timeout".into(),
            error_message: Some("provider request timed out".into()),
            error_retryable: true,
            provider_status: None,
            settled_at: "2026-08-13T12:00:30.000Z".into(),
        };
        settle_ai_call_attempt_failure_in_connection(&mut connection, &failure).unwrap();
        drop(connection);
        let reopened = Connection::open(&path).unwrap();
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.messages.len(), 1);
        assert_eq!(readback.call_attempts[0].status, "failed");
        assert_eq!(
            readback.call_attempts[0].error_code.as_deref(),
            Some("timeout")
        );
        assert_eq!(readback.call_attempts[0].result_message_id, None);
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b3_cancelled_stream_is_restart_readable_without_partial_assistant_message() {
        let path = temporary_database_path("b3-cancelled-stream");
        let mut connection = open_current_database(&path);
        let input = prepare_input(
            "stream-attempt-cancelled",
            "stream-attempt-cancelled",
            "message-user-cancelled",
            "2026-08-14T12:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &input).unwrap();
        settle_ai_call_attempt_failure_in_connection(
            &mut connection,
            &SettleAICallAttemptFailureInput {
                attempt_id: "stream-attempt-cancelled".into(),
                error_code: "cancelled".into(),
                error_message: Some("The AI request was cancelled by the user.".into()),
                error_retryable: true,
                provider_status: None,
                settled_at: "2026-08-14T12:00:01.000Z".into(),
            },
        )
        .unwrap();
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.messages.len(), 1);
        assert_eq!(readback.messages[0].id, "message-user-cancelled");
        assert_eq!(readback.call_attempts.len(), 1);
        let attempt = &readback.call_attempts[0];
        assert_eq!(attempt.id, attempt.request_id);
        assert_eq!(attempt.status, "failed");
        assert_eq!(attempt.error_code.as_deref(), Some("cancelled"));
        assert_eq!(attempt.result_message_id, None);
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn pre_provider_persistence_failure_rolls_back_message_and_attempt() {
        let path = temporary_database_path("pre-provider-failure");
        let mut connection = open_current_database(&path);
        connection
            .execute_batch(
                "CREATE TRIGGER fail_ai_call_attempt_prepare
                 BEFORE INSERT ON ai_call_attempts
                 BEGIN SELECT RAISE(FAIL, 'injected pre-provider persistence failure'); END;",
            )
            .unwrap();
        let input = prepare_input(
            "attempt-pre-failure",
            "request-pre-failure",
            "message-user-pre-failure",
            "2026-08-13T12:00:00.000Z",
        );
        let error = prepare_ai_call_attempt_in_connection(&mut connection, &input)
            .expect_err("pre-provider transaction must fail");
        assert!(
            error.contains("AI_DURABLE_PRE_PROVIDER_PERSISTENCE_FAILED"),
            "{error}"
        );
        for (table, expected) in [
            ("ai_conversations", 1_i64),
            ("ai_messages", 0_i64),
            ("ai_call_attempts", 0_i64),
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(
                count, expected,
                "{table} must roll back with the pre-provider gate"
            );
        }
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b4_requires_explicit_existing_conversation_before_pre_gate() {
        let path = temporary_database_path("b4-explicit-conversation");
        let mut connection = open_current_database(&path);
        let mut input = prepare_input(
            "attempt-missing-conversation",
            "request-missing-conversation",
            "message-missing-conversation",
            "2026-08-14T12:00:00.000Z",
        );
        input.conversation_id = "missing-conversation".into();
        let error = prepare_ai_call_attempt_in_connection(&mut connection, &input)
            .expect_err("implicit conversation fallback must be rejected");
        assert!(error.contains("AI_DURABLE_CONVERSATION_REQUIRED"), "{error}");
        let message_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM ai_messages", [], |row| row.get(0))
            .unwrap();
        let attempt_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM ai_call_attempts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(message_count, 0);
        assert_eq!(attempt_count, 0);
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b4_eager_empty_conversation_survives_restart_readback() {
        let path = temporary_database_path("b4-eager-empty-restart");
        let connection = open_current_database(&path);
        create_ai_conversation_in_connection(
            &connection,
            &CreateAIConversationInput {
                id: "conversation-eager-empty".into(),
                stable_key: "global-ai-chat/conversation-eager-empty".into(),
                created_at: "2026-08-14T12:00:00.000Z".into(),
            },
        )
        .expect("create eager empty conversation");
        drop(connection);

        let reopened = open_current_database(&path);
        let readback = read_ai_conversation_in_connection(
            &reopened,
            "conversation-eager-empty",
        )
        .expect("restart-equivalent empty conversation readback");
        assert_eq!(readback.conversation.id, "conversation-eager-empty");
        assert!(readback.messages.is_empty());
        assert!(readback.call_attempts.is_empty());
        let summaries = list_ai_conversations_in_connection(&reopened)
            .expect("list restart-equivalent conversations");
        let summary = summaries
            .iter()
            .find(|candidate| candidate.id == "conversation-eager-empty")
            .expect("empty conversation remains in canonical list");
        assert_eq!(summary.message_count, 0);
        assert!(summary.first_user_message.is_none());
        assert!(summary.latest_message.is_none());
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b4_conversation_summary_and_readback_are_isolated_and_deterministic() {
        let path = temporary_database_path("b4-conversation-summary");
        let mut connection = open_current_database(&path);
        let first = prepare_input(
            "attempt-first",
            "request-first",
            "message-first-user",
            "2026-08-14T12:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &first).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-first",
                "message-first-assistant",
                "2026-08-14T12:00:01.000Z",
            ),
        )
        .unwrap();

        create_ai_conversation_in_connection(
            &connection,
            &CreateAIConversationInput {
                id: "conversation-second".into(),
                stable_key: "global-ai-chat/conversation-second".into(),
                created_at: "2026-08-14T12:01:00.000Z".into(),
            },
        )
        .unwrap();
        let mut second = prepare_input(
            "attempt-second",
            "request-second",
            "message-second-user",
            "2026-08-14T12:01:00.000Z",
        );
        second.conversation_id = "conversation-second".into();
        prepare_ai_call_attempt_in_connection(&mut connection, &second).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-second",
                "message-second-assistant",
                "2026-08-14T12:01:01.000Z",
            ),
        )
        .unwrap();

        let summaries = list_ai_conversations_in_connection(&connection).unwrap();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].id, "conversation-second");
        assert_eq!(summaries[0].message_count, 2);
        assert_eq!(
            summaries[0].first_user_message.as_deref(),
            Some("question-message-second-user")
        );
        assert_eq!(
            summaries[0].latest_message.as_deref(),
            Some("answer-message-second-assistant")
        );
        let first_readback =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        let second_readback =
            read_ai_conversation_in_connection(&connection, "conversation-second").unwrap();
        assert_eq!(first_readback.messages.len(), 2);
        assert_eq!(second_readback.messages.len(), 2);
        assert!(first_readback
            .messages
            .iter()
            .all(|message| message.conversation_id == CURRENT_CONVERSATION_ID));
        assert!(second_readback
            .messages
            .iter()
            .all(|message| message.conversation_id == "conversation-second"));
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn context_change_creates_new_trace_without_overwriting_prior_provenance() {
        let path = temporary_database_path("context-provenance");
        let mut connection = open_current_database(&path);
        let first = prepare_input(
            "attempt-context-1",
            "request-context-1",
            "message-context-1",
            "2026-08-13T12:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &first).unwrap();

        let mut second = prepare_input(
            "attempt-context-2",
            "request-context-2",
            "message-context-2",
            "2026-08-13T12:01:00.000Z",
        );
        second.context_package_id = "context-2".into();
        second.context_source_refs = serde_json::json!([
            {
                "module": "project", "entityType": "project", "entityId": "project-2",
                "sourceKind": "userAuthored"
            },
            normal_qa_constraint_source_ref()
        ]);
        prepare_ai_call_attempt_in_connection(&mut connection, &second).unwrap();

        let readback =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.call_attempts[0].context_package_id, "context-1");
        assert_eq!(
            readback.call_attempts[0].context_source_refs[0]["entityId"],
            "project-1"
        );
        assert_eq!(readback.call_attempts[1].context_package_id, "context-2");
        assert_eq!(
            readback.call_attempts[1].context_source_refs[0]["entityId"],
            "project-2"
        );
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn post_provider_persistence_failure_leaves_explainable_started_attempt() {
        let path = temporary_database_path("post-provider-failure");
        let mut connection = open_current_database(&path);
        let input = prepare_input(
            "attempt-post-failure",
            "request-post-failure",
            "message-user-post-failure",
            "2026-08-13T12:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &input).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER fail_ai_assistant_persistence
                 BEFORE INSERT ON ai_messages WHEN NEW.role='assistant'
                 BEGIN SELECT RAISE(FAIL, 'injected assistant persistence failure'); END;",
            )
            .unwrap();
        let success = settle_success_input(
            "attempt-post-failure",
            "message-assistant-post-failure",
            "2026-08-13T12:00:01.000Z",
        );
        let error = settle_ai_call_attempt_success_in_connection(&mut connection, &success)
            .expect_err("settlement must fail");
        assert!(
            error.contains("AI_DURABLE_WRITE_FAILED") || error.contains("AI_DURABLE_POST_PROVIDER")
        );
        let readback =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.messages.len(), 1);
        assert_eq!(readback.call_attempts[0].status, "started");
        assert_eq!(readback.call_attempts[0].settled_at, None);
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn terminal_settlement_is_idempotent_but_conflicting_resettlement_fails_closed() {
        let path = temporary_database_path("terminal-invariants");
        let mut connection = open_current_database(&path);
        let input = prepare_input(
            "attempt-terminal",
            "request-terminal",
            "message-user-terminal",
            "2026-08-13T12:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &input).unwrap();
        let success = settle_success_input(
            "attempt-terminal",
            "message-assistant-terminal",
            "2026-08-13T12:00:01.000Z",
        );
        settle_ai_call_attempt_success_in_connection(&mut connection, &success).unwrap();
        settle_ai_call_attempt_success_in_connection(&mut connection, &success).unwrap();
        let failure = SettleAICallAttemptFailureInput {
            attempt_id: "attempt-terminal".into(),
            error_code: "provider_error".into(),
            error_message: None,
            error_retryable: true,
            provider_status: Some(503),
            settled_at: "2026-08-13T12:00:02.000Z".into(),
        };
        let error = settle_ai_call_attempt_failure_in_connection(&mut connection, &failure)
            .expect_err("terminal conflict must fail closed");
        assert!(error.contains("AI_DURABLE_TERMINAL_CONFLICT"));
        let direct_regression = connection
            .execute(
                "UPDATE ai_call_attempts SET status='started',settled_at=NULL,
                 result_message_id=NULL,response_truncated=NULL,usage_input_tokens=NULL,
                 usage_output_tokens=NULL,usage_total_tokens=NULL
                 WHERE id='attempt-terminal'",
                [],
            )
            .expect_err("SQLite must reject terminal-to-started regression");
        assert!(direct_regression
            .to_string()
            .contains("AI_DURABLE_TERMINAL_IMMUTABLE"));
        let readback =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.messages.len(), 2);
        assert_eq!(readback.call_attempts[0].status, "succeeded");
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b6_exact_authorization_set_is_atomic_deduped_restart_readable_and_immutable() {
        let path = temporary_database_path("b6-exact-set");
        let mut connection = open_current_database(&path);
        let first_path = seed_file_ref(
            &connection,
            &path,
            "file-ref-b6-a",
            "file",
            true,
            r#"N:\private\alpha.pdf"#,
        );
        seed_file_ref(
            &connection,
            &path,
            "file-ref-b6-b",
            "file",
            true,
            "beta.csv",
        );
        let mut input = prepare_input(
            "attempt-b6",
            "request-b6",
            "message-user-b6",
            "2026-08-14T01:00:00.000Z",
        );
        input.authorized_file_ref_ids = vec![
            "file-ref-b6-b".into(),
            "file-ref-b6-a".into(),
            "file-ref-b6-a".into(),
        ];
        let prepared = prepare_ai_call_attempt_in_connection(&mut connection, &input).unwrap();
        let attempt = prepared
            .readback
            .call_attempts
            .iter()
            .find(|attempt| attempt.id == "attempt-b6")
            .unwrap();
        assert_eq!(
            attempt
                .authorized_file_refs
                .iter()
                .map(|snapshot| snapshot.file_ref_id.as_str())
                .collect::<Vec<_>>(),
            vec!["file-ref-b6-a", "file-ref-b6-b"]
        );
        assert_eq!(attempt.authorized_file_refs[0].display_name, "alpha.pdf");
        assert!(!serde_json::to_string(attempt)
            .unwrap()
            .contains(path.parent().unwrap().to_string_lossy().as_ref()));
        let relation_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM ai_call_attempt_file_ref_authorizations
                 WHERE call_attempt_id='attempt-b6'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(relation_count, 2);
        assert!(connection
            .execute(
                "UPDATE ai_call_attempt_file_ref_authorizations SET display_name='changed'
                 WHERE call_attempt_id='attempt-b6'",
                [],
            )
            .expect_err("authorization snapshot update must fail")
            .to_string()
            .contains("AI_ATTACHMENT_AUTHORIZATION_IMMUTABLE"));
        assert!(connection
            .execute(
                "DELETE FROM ai_call_attempt_file_ref_authorizations
                 WHERE call_attempt_id='attempt-b6'",
                [],
            )
            .expect_err("authorization snapshot deletion must fail")
            .to_string()
            .contains("AI_ATTACHMENT_AUTHORIZATION_IMMUTABLE"));

        let cancelled = SettleAICallAttemptFailureInput {
            attempt_id: "attempt-b6".into(),
            error_code: "cancelled".into(),
            error_message: Some("Stopped by the user.".into()),
            error_retryable: true,
            provider_status: None,
            settled_at: "2026-08-14T01:00:01.000Z".into(),
        };
        let cancelled_readback =
            settle_ai_call_attempt_failure_in_connection(&mut connection, &cancelled).unwrap();
        assert_eq!(cancelled_readback.call_attempts[0].status, "failed");
        assert_eq!(cancelled_readback.call_attempts[0].authorized_file_refs.len(), 2);

        drop(connection);
        let connection = Connection::open(&path).expect("restart-equivalent reopen");
        let restarted = read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID)
            .expect("restart readback");
        assert_eq!(restarted.call_attempts[0].authorized_file_refs.len(), 2);
        std::fs::remove_file(first_path).expect("make task-local FileRef unavailable");
        let unavailable = read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID)
            .expect("historical unavailable readback");
        let alpha = unavailable.call_attempts[0]
            .authorized_file_refs
            .iter()
            .find(|snapshot| snapshot.file_ref_id == "file-ref-b6-a")
            .unwrap();
        assert_eq!(alpha.display_name, "alpha.pdf");
        assert_eq!(alpha.availability_status, "unavailable");
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b6_invalid_unavailable_directory_and_count_fail_without_partial_durable_writes() {
        let path = temporary_database_path("b6-atomic-rejections");
        let mut connection = open_current_database(&path);
        seed_file_ref(
            &connection,
            &path,
            "file-ref-b6-folder",
            "folder",
            true,
            "folder",
        );
        seed_file_ref(
            &connection,
            &path,
            "file-ref-b6-missing",
            "file",
            false,
            "missing.txt",
        );
        let cases = [
            (
                vec!["does-not-exist".to_string()],
                "AI_ATTACHMENT_ID_INVALID",
            ),
            (
                vec!["file-ref-b6-folder".to_string()],
                "AI_ATTACHMENT_REFERENCE_KIND_UNSUPPORTED",
            ),
            (
                vec!["file-ref-b6-missing".to_string()],
                "AI_ATTACHMENT_UNAVAILABLE",
            ),
            (
                (0..=MAX_AUTHORIZED_FILE_REFS_PER_CALL)
                    .map(|index| format!("too-many-{index}"))
                    .collect(),
                "AI_ATTACHMENT_COUNT_EXCEEDED",
            ),
        ];
        for (index, (ids, code)) in cases.into_iter().enumerate() {
            let mut input = prepare_input(
                &format!("attempt-rejected-{index}"),
                &format!("request-rejected-{index}"),
                &format!("message-rejected-{index}"),
                "2026-08-14T02:00:00.000Z",
            );
            input.authorized_file_ref_ids = ids;
            let error = prepare_ai_call_attempt_in_connection(&mut connection, &input)
                .expect_err("invalid authorization must fail closed");
            assert!(error.contains(code), "expected {code}, received {error}");
        }
        for table in [
            "ai_messages",
            "ai_call_attempts",
            "ai_call_attempt_file_ref_authorizations",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table} must remain empty");
        }
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b6_authorization_does_not_inherit_and_is_isolated_by_conversation() {
        let path = temporary_database_path("b6-conversation-isolation");
        let mut connection = open_current_database(&path);
        seed_file_ref(
            &connection,
            &path,
            "file-ref-b6-isolated",
            "file",
            true,
            "isolated.md",
        );
        let mut first = prepare_input(
            "attempt-b6-first",
            "request-b6-first",
            "message-b6-first",
            "2026-08-14T03:00:00.000Z",
        );
        first.authorized_file_ref_ids = vec!["file-ref-b6-isolated".into()];
        prepare_ai_call_attempt_in_connection(&mut connection, &first).unwrap();

        let next = prepare_input(
            "attempt-b6-next",
            "request-b6-next",
            "message-b6-next",
            "2026-08-14T03:01:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &next).unwrap();
        create_ai_conversation_in_connection(
            &connection,
            &CreateAIConversationInput {
                id: "conversation-b6-other".into(),
                stable_key: "global-ai-chat/conversation-b6-other".into(),
                created_at: "2026-08-14T03:02:00.000Z".into(),
            },
        )
        .unwrap();
        let mut other = prepare_input(
            "attempt-b6-other",
            "request-b6-other",
            "message-b6-other",
            "2026-08-14T03:03:00.000Z",
        );
        other.conversation_id = "conversation-b6-other".into();
        prepare_ai_call_attempt_in_connection(&mut connection, &other).unwrap();

        let first_readback =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(first_readback.call_attempts[0].authorized_file_refs.len(), 1);
        assert!(first_readback.call_attempts[1].authorized_file_refs.is_empty());
        let other_readback =
            read_ai_conversation_in_connection(&connection, "conversation-b6-other").unwrap();
        assert_eq!(other_readback.call_attempts.len(), 1);
        assert!(other_readback.call_attempts[0].authorized_file_refs.is_empty());
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b6_selector_returns_only_safe_metadata_and_v55_upgrades_to_v56() {
        let path = temporary_database_path("b6-selector-migration");
        let connection = open_current_database(&path);
        seed_file_ref(
            &connection,
            &path,
            "file-ref-b6-selector",
            "file",
            true,
            r#"C:\secret\safe-name.pdf"#,
        );
        let selectable = list_selectable_file_refs_in_connection(&connection).unwrap();
        let selected = selectable
            .iter()
            .find(|candidate| candidate.file_ref_id == "file-ref-b6-selector")
            .unwrap();
        assert_eq!(selected.display_name, "safe-name.pdf");
        assert_eq!(selected.availability_status, "available");
        let serialized = serde_json::to_string(&selectable).unwrap();
        assert!(!serialized.contains(path.parent().unwrap().to_string_lossy().as_ref()));

        connection
            .execute_batch(
                "DROP TABLE ai_standard_results;
                 DROP TABLE ai_call_attempt_file_ref_authorizations;
                 DELETE FROM schema_migrations WHERE version=58;
                 DELETE FROM schema_migrations WHERE version=56;
                 PRAGMA user_version=55;",
            )
            .expect("construct v55 fixture");
        super::super::schema::run_migrations(&connection).expect("upgrade v55 through current");
        assert!(attachment_authorization_schema_is_current(&connection).unwrap());
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, AI_STANDARD_RESULT_SCHEMA_VERSION);
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp13_c1_a6_selector_propagates_the_rust_owned_metadata_reservation_without_path_or_body() {
        let path = temporary_database_path("a6-material-reservation-catalog");
        let connection = open_current_database(&path);
        let material_path = path
            .parent()
            .expect("database parent")
            .join("lp13_c1_a2_authorized_material_fixture.md");
        std::fs::write(&material_path, "x".repeat(294)).expect("A6 catalog fixture");
        let material_path_text = material_path.to_string_lossy().to_string();
        connection
            .execute(
                "INSERT INTO file_refs(
                   id,owner_type,owner_id,manuscript_channel,resource_kind,file_role,
                   location_mode,file_type,path,path_identity_key,title,created_at,updated_at
                 ) VALUES ('file-a6-reservation','Experiment','experiment-a6','primary',
                           'file','attachment','external','text/markdown',?1,?1,
                           'A6 safe fixture','2026-08-17T00:00:00.000Z',
                           '2026-08-17T00:00:00.000Z')",
                params![material_path_text],
            )
            .expect("A6 canonical FileRef");
        let selectable = list_selectable_file_refs_in_connection(&connection).unwrap();
        let selected = selectable
            .iter()
            .find(|candidate| candidate.file_ref_id == "file-a6-reservation")
            .expect("A6 selectable material");
        assert_eq!(selected.material_read_status, "supported");
        assert_eq!(selected.material_prompt_reservation_characters, Some(2_227));
        let reviewed_receipt = selected
            .material_freshness_receipt
            .as_ref()
            .expect("A4 canonical metadata-only receipt");
        assert_eq!(reviewed_receipt.file_ref_id, "file-a6-reservation");
        assert_eq!(
            reviewed_receipt.receipt_version,
            crate::authorized_material::MATERIAL_FRESHNESS_RECEIPT_VERSION
        );
        assert_eq!(reviewed_receipt.source_token.len(), 64);
        let repeated = list_selectable_file_refs_in_connection(&connection).unwrap();
        assert_eq!(
            repeated[0].material_freshness_receipt.as_ref(),
            Some(reviewed_receipt)
        );
        let serialized = serde_json::to_string(selected).expect("safe selector JSON");
        assert!(serialized.contains("materialPromptReservationCharacters"));
        assert!(serialized.contains("materialFreshnessReceipt"));
        assert!(!serialized.contains(&material_path_text));
        assert!(!serialized.contains(&"x".repeat(64)));
        std::fs::write(&material_path, "y".repeat(294)).expect("A4 same-size catalog edit");
        let changed = list_selectable_file_refs_in_connection(&connection).unwrap();
        assert_ne!(
            changed[0]
                .material_freshness_receipt
                .as_ref()
                .expect("changed A4 receipt")
                .source_token,
            reviewed_receipt.source_token
        );
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup A6 selector fixture");
    }

    #[test]
    fn b8_retry_prepare_reuses_user_message_orders_attempts_and_replays_immutably() {
        let path = temporary_database_path("b8-retry-prepare");
        let mut connection = open_current_database(&path);
        let original = prepare_input(
            "attempt-b8-failed",
            "attempt-b8-failed",
            "message-b8-user",
            "2026-08-14T10:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &original).unwrap();
        settle_ai_call_attempt_failure_in_connection(
            &mut connection,
            &settle_failure_input(
                "attempt-b8-failed",
                "timeout",
                "2026-08-14T10:00:01.000Z",
            ),
        )
        .unwrap();
        let eligible =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        assert!(eligible.retry_regenerate.retry_eligible);
        assert!(!eligible.retry_regenerate.regenerate_eligible);

        let retry = retry_regenerate_input(
            "attempt-b8-retry",
            AIChatAttemptActionIntent::Retry,
            "message-b8-user",
            "attempt-b8-failed",
            None,
            "2026-08-14T10:00:02.000Z",
        );
        let mut version_conflict = retry.clone();
        version_conflict.attempt_id = "attempt-a3-version-conflict".into();
        version_conflict.request_id = "attempt-a3-version-conflict".into();
        version_conflict
            .context_source_refs
            .as_array_mut()
            .and_then(|refs| refs.iter_mut().find(|value| is_a3_constraint_source_ref(value)))
            .and_then(Value::as_object_mut)
            .expect("constraint ref object")
            .insert("constraintVersion".into(), serde_json::json!(2));
        let version_error = prepare_ai_retry_regenerate_attempt_in_connection(
            &mut connection,
            &version_conflict,
        )
        .expect_err("retry must not silently change a frozen descriptor version");
        assert!(
            version_error.contains("AI_CONSTRAINT_RETRY_INHERITANCE_INVALID"),
            "{version_error}"
        );
        let count_after_version_rejection: i64 = connection
            .query_row("SELECT COUNT(*) FROM ai_call_attempts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count_after_version_rejection, 1);

        let prepared =
            prepare_ai_retry_regenerate_attempt_in_connection(&mut connection, &retry).unwrap();
        assert!(prepared.provider_invocation_authorized);
        assert_eq!(prepared.readback.messages.len(), 1);
        assert_eq!(prepared.readback.projected_messages.len(), 1);
        assert_eq!(prepared.readback.call_attempts.len(), 2);
        assert_eq!(prepared.readback.call_attempts[0].sequence, 1);
        assert_eq!(prepared.readback.call_attempts[1].sequence, 2);
        assert_eq!(
            prepared.readback.call_attempts[1]
                .trigger_message_id
                .as_deref(),
            Some("message-b8-user")
        );
        assert_eq!(
            prepared.readback.call_attempts[1]
                .trigger_call_attempt_id
                .as_deref(),
            Some("attempt-b8-failed")
        );
        assert_eq!(
            frozen_constraint_source_ref(&prepared.readback.call_attempts[0].context_source_refs),
            frozen_constraint_source_ref(&prepared.readback.call_attempts[1].context_source_refs)
        );
        assert!(prepared.readback.call_attempts[1]
            .authorized_file_refs
            .is_empty());
        let immutable = prepared.readback.call_attempts[1].clone();

        let replay =
            prepare_ai_retry_regenerate_attempt_in_connection(&mut connection, &retry).unwrap();
        assert!(replay.provider_invocation_authorized);
        assert_eq!(replay.readback.call_attempts.len(), 2);
        assert_eq!(replay.readback.call_attempts[1], immutable);

        let mut conflict = retry.clone();
        conflict.trigger_message_id = "different-message".into();
        let error = prepare_ai_retry_regenerate_attempt_in_connection(&mut connection, &conflict)
            .expect_err("different immutable identity must fail closed");
        assert!(error.contains("attempt_identity_conflict"), "{error}");
        let row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM ai_call_attempts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(row_count, 2);

        let terminal = settle_ai_call_attempt_failure_in_connection(
            &mut connection,
            &settle_failure_input(
                "attempt-b8-retry",
                "cancelled",
                "2026-08-14T10:00:03.000Z",
            ),
        )
        .unwrap();
        assert!(terminal.retry_regenerate.retry_eligible);
        let terminal_replay =
            prepare_ai_retry_regenerate_attempt_in_connection(&mut connection, &retry).unwrap();
        assert!(!terminal_replay.provider_invocation_authorized);
        assert_eq!(terminal_replay.readback.call_attempts.len(), 2);

        let mut malformed = terminal_replay.readback.call_attempts[1].clone();
        malformed.status = "succeeded".into();
        malformed.result_message_id = None;
        let core = project_effective_conversation(
            CURRENT_CONVERSATION_ID,
            &terminal_replay.readback.messages,
            &[terminal_replay.readback.call_attempts[0].clone(), malformed],
        );
        let projection = retry_regenerate_projection(&core, false, false);
        assert_eq!(projection.safe_integrity_state, "malformed_success_ignored");
        assert!(!projection.retry_eligible);
        assert!(!projection.regenerate_eligible);

        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp13_d1_a8_cross_conversation_retry_is_admitted_and_read_projection_matches_prepare() {
        let path = temporary_database_path("d1-a8-conversation-retry-boundary");
        let mut connection = open_current_database(&path);
        const OTHER_CONVERSATION_ID: &str = "conversation-d1-a8-retry-other";

        create_ai_conversation_in_connection(
            &connection,
            &CreateAIConversationInput {
                id: OTHER_CONVERSATION_ID.into(),
                stable_key: "global-ai-chat/d1-a8-retry-other".into(),
                created_at: "2026-08-18T17:30:00.000Z".into(),
            },
        )
        .expect("create independent conversation");

        let first = prepare_input(
            "attempt-d1-a8-retry-source",
            "attempt-d1-a8-retry-source",
            "message-d1-a8-retry-user",
            "2026-08-18T17:30:01.000Z",
        );
        let first_prepared =
            prepare_ai_call_attempt_in_connection(&mut connection, &first).unwrap();
        assert!(first_prepared.provider_invocation_authorized);

        let mut independent = prepare_input(
            "attempt-d1-a8-unrelated-active",
            "attempt-d1-a8-unrelated-active",
            "message-d1-a8-unrelated-user",
            "2026-08-18T17:30:02.000Z",
        );
        independent.conversation_id = OTHER_CONVERSATION_ID.into();
        let independent_prepared =
            prepare_ai_call_attempt_in_connection(&mut connection, &independent).unwrap();
        assert!(independent_prepared.provider_invocation_authorized);

        settle_ai_call_attempt_failure_in_connection(
            &mut connection,
            &settle_failure_input(
                "attempt-d1-a8-retry-source",
                "timeout",
                "2026-08-18T17:30:03.000Z",
            ),
        )
        .unwrap();

        let eligible =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        assert!(!eligible.retry_regenerate.active_conflict);
        assert!(eligible.retry_regenerate.retry_eligible);

        let retry = retry_regenerate_input(
            "attempt-d1-a8-retry",
            AIChatAttemptActionIntent::Retry,
            "message-d1-a8-retry-user",
            "attempt-d1-a8-retry-source",
            None,
            "2026-08-18T17:30:04.000Z",
        );
        let retry_prepared =
            prepare_ai_retry_regenerate_attempt_in_connection(&mut connection, &retry).unwrap();
        assert!(retry_prepared.provider_invocation_authorized);
        assert!(retry_prepared.readback.retry_regenerate.active_conflict);

        let started_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM ai_call_attempts WHERE status='started'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(started_count, 2);
        let current_attempt_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM ai_call_attempts WHERE conversation_id=?1",
                [CURRENT_CONVERSATION_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(current_attempt_count, 2);

        let conflicting_retry = retry_regenerate_input(
            "attempt-d1-a8-same-conversation-conflict",
            AIChatAttemptActionIntent::Retry,
            "message-d1-a8-retry-user",
            "attempt-d1-a8-retry-source",
            None,
            "2026-08-18T17:30:05.000Z",
        );
        let conflict = prepare_ai_retry_regenerate_attempt_in_connection(
            &mut connection,
            &conflicting_retry,
        )
        .expect_err("same-Conversation conflicting Retry must remain blocked");
        assert!(conflict.contains("retry_regenerate_not_eligible"), "{conflict}");
        let count_after_conflict: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM ai_call_attempts WHERE conversation_id=?1",
                [CURRENT_CONVERSATION_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count_after_conflict, 2);

        let retry_terminal = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-d1-a8-retry",
                "message-d1-a8-retry-assistant",
                "2026-08-18T17:30:06.000Z",
            ),
        )
        .unwrap();
        assert_eq!(retry_terminal.call_attempts.len(), 2);
        assert_eq!(retry_terminal.call_attempts[0].status, "failed");
        assert_eq!(retry_terminal.call_attempts[1].status, "succeeded");
        assert_eq!(retry_terminal.call_attempts[1].usage_total_tokens, Some(30));
        assert!(!retry_terminal.retry_regenerate.active_conflict);

        settle_ai_call_attempt_failure_in_connection(
            &mut connection,
            &settle_failure_input(
                "attempt-d1-a8-unrelated-active",
                "cancelled",
                "2026-08-18T17:30:07.000Z",
            ),
        )
        .unwrap();
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let first_readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        let independent_readback =
            read_ai_conversation_in_connection(&reopened, OTHER_CONVERSATION_ID).unwrap();
        assert_eq!(first_readback.call_attempts.len(), 2);
        assert_eq!(first_readback.call_attempts[1].id, "attempt-d1-a8-retry");
        assert_eq!(first_readback.call_attempts[1].status, "succeeded");
        assert_eq!(first_readback.call_attempts[1].usage_total_tokens, Some(30));
        assert_eq!(independent_readback.call_attempts.len(), 1);
        assert_eq!(independent_readback.call_attempts[0].status, "failed");
        assert!(!first_readback.retry_regenerate.active_conflict);
        assert!(!independent_readback.retry_regenerate.active_conflict);
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp13_d1_a8_cross_conversation_context_followups_coexist_and_settle_independently() {
        let path = temporary_database_path("d1-a8-context-followup-boundary");
        let mut connection = open_current_database(&path);
        const OTHER_CONVERSATION_ID: &str = "conversation-d1-a8-context-other";

        create_ai_conversation_in_connection(
            &connection,
            &CreateAIConversationInput {
                id: OTHER_CONVERSATION_ID.into(),
                stable_key: "global-ai-chat/d1-a8-context-other".into(),
                created_at: "2026-08-18T18:00:00.000Z".into(),
            },
        )
        .expect("create independent Context Request conversation");

        let candidate = identity_context_request_candidate();
        prepare_ai_call_attempt_in_connection(
            &mut connection,
            &prepare_input(
                "attempt-d1-a8-context-source-a",
                "attempt-d1-a8-context-source-a",
                "message-d1-a8-context-user-a",
                "2026-08-18T18:00:01.000Z",
            ),
        )
        .unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &context_request_success_input(
                "attempt-d1-a8-context-source-a",
                "message-d1-a8-context-assistant-a",
                "context-request-d1-a8-a",
                serde_json::json!([{
                    "refKind": "AI_RESEARCH_OBJECT",
                    "refId": "task-2",
                    "contributionKind": "IDENTITY_METADATA"
                }]),
                serde_json::json!([candidate.clone()]),
                serde_json::json!([{
                    "refKind": "AI_RESEARCH_OBJECT",
                    "refId": "task-2",
                    "projectId": "project-1",
                    "label": "Task Two",
                    "entityType": "task",
                    "allowedContributionKinds": ["IDENTITY_METADATA"]
                }]),
                "2026-08-18T18:00:02.000Z",
            ),
        )
        .unwrap();

        let mut source_b = prepare_input(
            "attempt-d1-a8-context-source-b",
            "attempt-d1-a8-context-source-b",
            "message-d1-a8-context-user-b",
            "2026-08-18T18:00:03.000Z",
        );
        source_b.conversation_id = OTHER_CONVERSATION_ID.into();
        prepare_ai_call_attempt_in_connection(&mut connection, &source_b).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &context_request_success_input(
                "attempt-d1-a8-context-source-b",
                "message-d1-a8-context-assistant-b",
                "context-request-d1-a8-b",
                serde_json::json!([{
                    "refKind": "AI_RESEARCH_OBJECT",
                    "refId": "task-2",
                    "contributionKind": "IDENTITY_METADATA"
                }]),
                serde_json::json!([candidate.clone()]),
                serde_json::json!([{
                    "refKind": "AI_RESEARCH_OBJECT",
                    "refId": "task-2",
                    "projectId": "project-1",
                    "label": "Task Two",
                    "entityType": "task",
                    "allowedContributionKinds": ["IDENTITY_METADATA"]
                }]),
                "2026-08-18T18:00:04.000Z",
            ),
        )
        .unwrap();

        let followup_a = context_request_followup_input(
            "context-request-d1-a8-a",
            "message-d1-a8-context-action-a",
            "attempt-d1-a8-context-followup-a",
            serde_json::json!([candidate.clone()]),
            Vec::new(),
            "2026-08-18T18:00:05.000Z",
        );
        let prepared_a =
            prepare_ai_context_request_followup_in_connection(&mut connection, &followup_a)
                .unwrap();
        assert!(prepared_a.provider_invocation_authorized);

        let before_b =
            read_ai_conversation_in_connection(&connection, OTHER_CONVERSATION_ID).unwrap();
        assert!(!before_b.retry_regenerate.active_conflict);
        assert!(before_b.retry_regenerate.regenerate_eligible);

        let mut followup_b = context_request_followup_input(
            "context-request-d1-a8-b",
            "message-d1-a8-context-action-b",
            "attempt-d1-a8-context-followup-b",
            serde_json::json!([candidate]),
            Vec::new(),
            "2026-08-18T18:00:06.000Z",
        );
        followup_b.conversation_id = OTHER_CONVERSATION_ID.into();
        let prepared_b =
            prepare_ai_context_request_followup_in_connection(&mut connection, &followup_b)
                .unwrap();
        assert!(prepared_b.provider_invocation_authorized);

        let started_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM ai_call_attempts WHERE status='started'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(started_count, 2);
        assert_eq!(prepared_a.readback.context_requests[0].state, "APPROVED");
        assert_eq!(prepared_b.readback.context_requests[0].state, "APPROVED");

        let duplicate = prepare_ai_context_request_followup_in_connection(
            &mut connection,
            &followup_b,
        )
        .expect_err("same Context Request must not create a duplicate follow-up while active");
        assert!(duplicate.contains("AI_CONTEXT_REQUEST_TERMINAL_CONFLICT"));
        let mut duplicate_lineage = followup_b.clone();
        duplicate_lineage.action_message_id = "message-d1-a8-context-action-b-duplicate".into();
        duplicate_lineage.attempt_id = "attempt-d1-a8-context-followup-b-duplicate".into();
        duplicate_lineage.request_id = duplicate_lineage.attempt_id.clone();
        let lineage_conflict = prepare_ai_context_request_followup_in_connection(
            &mut connection,
            &duplicate_lineage,
        )
        .expect_err("same Context Request lineage must remain single-flight");
        assert!(lineage_conflict.contains("AI_CONTEXT_REQUEST_TERMINAL_CONFLICT"));
        let count_after_duplicates: i64 = connection
            .query_row("SELECT COUNT(*) FROM ai_call_attempts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count_after_duplicates, 4);

        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-d1-a8-context-followup-a",
                "message-d1-a8-context-followup-assistant-a",
                "2026-08-18T18:00:07.000Z",
            ),
        )
        .unwrap();
        settle_ai_call_attempt_failure_in_connection(
            &mut connection,
            &settle_failure_input(
                "attempt-d1-a8-context-followup-b",
                "cancelled",
                "2026-08-18T18:00:08.000Z",
            ),
        )
        .unwrap();
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent Context reopen");
        let readback_a =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        let readback_b =
            read_ai_conversation_in_connection(&reopened, OTHER_CONVERSATION_ID).unwrap();
        assert_eq!(readback_a.call_attempts.len(), 2);
        assert_eq!(readback_b.call_attempts.len(), 2);
        assert_eq!(readback_a.call_attempts[1].status, "succeeded");
        assert_eq!(readback_a.call_attempts[1].usage_total_tokens, Some(30));
        assert_eq!(readback_b.call_attempts[1].status, "failed");
        assert_eq!(readback_a.context_requests[0].state, "APPROVED");
        assert_eq!(
            readback_a.context_requests[0]
                .followup_call_attempt_id
                .as_deref(),
            Some("attempt-d1-a8-context-followup-a")
        );
        assert_eq!(readback_b.context_requests[0].state, "APPROVED");
        assert_eq!(
            readback_b.context_requests[0]
                .followup_call_attempt_id
                .as_deref(),
            Some("attempt-d1-a8-context-followup-b")
        );
        assert!(!readback_a.retry_regenerate.active_conflict);
        assert!(!readback_b.retry_regenerate.active_conflict);
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b8_regenerate_projects_latest_valid_success_and_preserves_last_good_on_failure() {
        let path = temporary_database_path("b8-regenerate-projection");
        let mut connection = open_current_database(&path);
        let original = prepare_input(
            "attempt-b8-success-1",
            "attempt-b8-success-1",
            "message-b8-regenerate-user",
            "2026-08-14T11:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &original).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-b8-success-1",
                "message-b8-assistant-1",
                "2026-08-14T11:00:01.000Z",
            ),
        )
        .unwrap();

        let regenerate = retry_regenerate_input(
            "attempt-b8-success-2",
            AIChatAttemptActionIntent::Regenerate,
            "message-b8-regenerate-user",
            "attempt-b8-success-1",
            Some("message-b8-assistant-1"),
            "2026-08-14T11:00:02.000Z",
        );
        let prepared = prepare_ai_retry_regenerate_attempt_in_connection(
            &mut connection,
            &regenerate,
        )
        .unwrap();
        assert!(prepared.provider_invocation_authorized);
        assert_eq!(
            prepared.readback.call_attempts[1]
                .trigger_call_attempt_id
                .as_deref(),
            Some("attempt-b8-success-1")
        );
        assert_eq!(
            frozen_constraint_source_ref(&prepared.readback.call_attempts[0].context_source_refs),
            frozen_constraint_source_ref(&prepared.readback.call_attempts[1].context_source_refs)
        );
        let started_replay = prepare_ai_retry_regenerate_attempt_in_connection(
            &mut connection,
            &regenerate,
        )
        .unwrap();
        assert!(started_replay.provider_invocation_authorized);
        assert_eq!(started_replay.readback.call_attempts.len(), 2);

        let second = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-b8-success-2",
                "message-b8-assistant-2",
                "2026-08-14T11:00:03.000Z",
            ),
        )
        .unwrap();
        assert_eq!(second.messages.len(), 3);
        assert_eq!(second.projected_messages.len(), 2);
        assert_eq!(second.projected_messages[0].id, "message-b8-regenerate-user");
        assert_eq!(second.projected_messages[1].id, "message-b8-assistant-2");
        assert_eq!(
            second.retry_regenerate.effective_source_attempt_id.as_deref(),
            Some("attempt-b8-success-2")
        );
        assert!(second.retry_regenerate.regenerate_eligible);
        let terminal_replay = prepare_ai_retry_regenerate_attempt_in_connection(
            &mut connection,
            &regenerate,
        )
        .unwrap();
        assert!(!terminal_replay.provider_invocation_authorized);
        assert_eq!(terminal_replay.readback.call_attempts.len(), 2);

        let mut stale_draft = prepare_input(
            "attempt-b8-stale-draft",
            "request-b8-stale-draft",
            "unused-b8-stale-draft",
            "2026-08-14T11:00:04.000Z",
        );
        stale_draft.purpose = "action_draft_generation".into();
        stale_draft.user_message = None;
        stale_draft.context_source_refs = serde_json::json!([]);
        stale_draft.trigger_message_id = Some("message-b8-assistant-1".into());
        stale_draft.trigger_call_attempt_id = Some("attempt-b8-success-1".into());
        let error = prepare_ai_call_attempt_in_connection(&mut connection, &stale_draft)
            .expect_err("superseded answer must not source Action Draft");
        assert!(error.contains("AI_DURABLE_TRIGGER_INVALID"), "{error}");

        let failed_regenerate = retry_regenerate_input(
            "attempt-b8-failed-regenerate",
            AIChatAttemptActionIntent::Regenerate,
            "message-b8-regenerate-user",
            "attempt-b8-success-2",
            Some("message-b8-assistant-2"),
            "2026-08-14T11:00:05.000Z",
        );
        prepare_ai_retry_regenerate_attempt_in_connection(
            &mut connection,
            &failed_regenerate,
        )
        .unwrap();
        let failed = settle_ai_call_attempt_failure_in_connection(
            &mut connection,
            &settle_failure_input(
                "attempt-b8-failed-regenerate",
                "cancelled",
                "2026-08-14T11:00:06.000Z",
            ),
        )
        .unwrap();
        assert_eq!(failed.messages.len(), 3);
        assert_eq!(failed.projected_messages.len(), 2);
        assert_eq!(failed.projected_messages[1].id, "message-b8-assistant-2");
        assert!(failed.retry_regenerate.retry_eligible);
        assert!(failed.retry_regenerate.regenerate_eligible);

        let mut current_draft = prepare_input(
            "attempt-b8-current-draft",
            "request-b8-current-draft",
            "unused-b8-current-draft",
            "2026-08-14T11:00:07.000Z",
        );
        current_draft.purpose = "action_draft_generation".into();
        current_draft.user_message = None;
        current_draft.context_source_refs = serde_json::json!([]);
        current_draft.trigger_message_id = Some("message-b8-assistant-2".into());
        current_draft.trigger_call_attempt_id = Some("attempt-b8-success-2".into());
        prepare_ai_call_attempt_in_connection(&mut connection, &current_draft).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-b8-current-draft".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: None,
                settled_at: "2026-08-14T11:00:08.000Z".into(),
            },
        )
        .unwrap();

        let durable =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        let mut malformed = durable.call_attempts[2].clone();
        malformed.status = "succeeded".into();
        malformed.result_message_id = None;
        let core = project_effective_conversation(
            CURRENT_CONVERSATION_ID,
            &durable.messages,
            &[
                durable.call_attempts[0].clone(),
                durable.call_attempts[1].clone(),
                malformed,
            ],
        );
        let safe = retry_regenerate_projection(&core, false, false);
        assert_eq!(safe.safe_integrity_state, "malformed_success_ignored");
        assert_eq!(
            safe.effective_assistant_message_id.as_deref(),
            Some("message-b8-assistant-2")
        );
        assert!(safe.regenerate_eligible);

        drop(connection);
        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let restarted =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(restarted.projected_messages.len(), 2);
        assert_eq!(restarted.projected_messages[1].id, "message-b8-assistant-2");
        assert_eq!(restarted.call_attempts.len(), 4);
        assert_eq!(
            restarted.call_attempts[1].trigger_call_attempt_id.as_deref(),
            Some("attempt-b8-success-1")
        );
        assert_eq!(
            frozen_constraint_source_ref(&restarted.call_attempts[0].context_source_refs),
            frozen_constraint_source_ref(&restarted.call_attempts[1].context_source_refs)
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn a3_legacy_regenerate_marks_only_the_new_attempt_and_survives_reopen() {
        let path = temporary_database_path("a3-legacy-regenerate");
        let mut connection = open_current_database(&path);
        let original = prepare_input(
            "attempt-a3-legacy-source",
            "attempt-a3-legacy-source",
            "message-a3-legacy-user",
            "2026-08-15T10:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &original).unwrap();
        let legacy_source_refs = serde_json::json!([{
            "module": "project",
            "entityType": "project",
            "entityId": "project-a3-legacy",
            "sourceKind": "userAuthored"
        }]);
        let legacy_source_text = serde_json::to_string(&legacy_source_refs).unwrap();
        connection
            .execute(
                "UPDATE ai_call_attempts SET context_source_refs_json=?1 WHERE id=?2",
                params![legacy_source_text, "attempt-a3-legacy-source"],
            )
            .unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a3-legacy-source",
                "message-a3-legacy-assistant",
                "2026-08-15T10:00:01.000Z",
            ),
        )
        .unwrap();

        let source_before: String = connection
            .query_row(
                "SELECT context_source_refs_json FROM ai_call_attempts WHERE id=?1",
                ["attempt-a3-legacy-source"],
                |row| row.get(0),
            )
            .unwrap();
        let mut regenerate = retry_regenerate_input(
            "attempt-a3-from-legacy",
            AIChatAttemptActionIntent::Regenerate,
            "message-a3-legacy-user",
            "attempt-a3-legacy-source",
            Some("message-a3-legacy-assistant"),
            "2026-08-15T10:00:02.000Z",
        );
        regenerate
            .context_source_refs
            .as_array_mut()
            .and_then(|refs| refs.iter_mut().find(|value| is_a3_constraint_source_ref(value)))
            .and_then(Value::as_object_mut)
            .expect("new A3 descriptor")
            .insert(
                "legacySourceMarker".into(),
                serde_json::json!("PRE_A3_ORDINARY_CHAT_SOURCE"),
            );

        let prepared = prepare_ai_retry_regenerate_attempt_in_connection(
            &mut connection,
            &regenerate,
        )
        .unwrap();
        assert!(prepared.provider_invocation_authorized);
        assert_eq!(
            prepared.readback.call_attempts[1]
                .trigger_call_attempt_id
                .as_deref(),
            Some("attempt-a3-legacy-source")
        );
        let source_after: String = connection
            .query_row(
                "SELECT context_source_refs_json FROM ai_call_attempts WHERE id=?1",
                ["attempt-a3-legacy-source"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_after, source_before);
        assert!(a3_constraint_source_ref(&serde_json::from_str::<Value>(&source_after).unwrap())
            .unwrap()
            .is_none());
        let next_descriptor = frozen_constraint_source_ref(
            &prepared.readback.call_attempts[1].context_source_refs,
        );
        assert_eq!(
            next_descriptor.get("legacySourceMarker").and_then(Value::as_str),
            Some("PRE_A3_ORDINARY_CHAT_SOURCE")
        );
        assert_eq!(
            next_descriptor.get("constraintCategory").and_then(Value::as_str),
            Some("NORMAL_QA")
        );
        assert_eq!(
            next_descriptor.get("constraintVersion").and_then(Value::as_u64),
            Some(1)
        );

        settle_ai_call_attempt_failure_in_connection(
            &mut connection,
            &settle_failure_input(
                "attempt-a3-from-legacy",
                "cancelled",
                "2026-08-15T10:00:03.000Z",
            ),
        )
        .unwrap();
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let restarted =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(restarted.call_attempts.len(), 2);
        assert_eq!(restarted.call_attempts[0].context_source_refs, legacy_source_refs);
        assert_eq!(
            restarted.call_attempts[1]
                .trigger_call_attempt_id
                .as_deref(),
            Some("attempt-a3-legacy-source")
        );
        assert_eq!(
            frozen_constraint_source_ref(&restarted.call_attempts[1].context_source_refs),
            next_descriptor
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b8_any_attempt_attachment_authorization_blocks_before_new_attempt() {
        let path = temporary_database_path("b8-attachment-exists-gate");
        let mut connection = open_current_database(&path);
        seed_file_ref(
            &connection,
            &path,
            "file-ref-b8-gated",
            "file",
            true,
            "gated.md",
        );
        let mut original = prepare_input(
            "attempt-b8-authorized-old",
            "attempt-b8-authorized-old",
            "message-b8-authorized-user",
            "2026-08-14T12:00:00.000Z",
        );
        original.authorized_file_ref_ids = vec!["file-ref-b8-gated".into()];
        prepare_ai_call_attempt_in_connection(&mut connection, &original).unwrap();
        settle_ai_call_attempt_failure_in_connection(
            &mut connection,
            &settle_failure_input(
                "attempt-b8-authorized-old",
                "timeout",
                "2026-08-14T12:00:01.000Z",
            ),
        )
        .unwrap();

        connection
            .execute(
                "INSERT INTO ai_call_attempts(
                   id,request_id,conversation_id,sequence,purpose,trigger_message_id,
                   provider,model,status,context_package_id,context_package_version,
                   context_source_refs_json,warnings_json,prompt_package_id,prompt_created_at,
                   error_code,error_message,error_retryable,started_at,settled_at
                 ) VALUES (
                   'attempt-b8-latest-empty','attempt-b8-latest-empty',?1,2,'chat_response',?2,
                   'deepseek','deepseek-v4-flash','failed','context-b8-latest','1',
                   '[]','[]','prompt-b8-latest','2026-08-14T12:00:02.000Z',
                   'timeout','safe-timeout',1,'2026-08-14T12:00:02.000Z','2026-08-14T12:00:03.000Z'
                 )",
                params![CURRENT_CONVERSATION_ID, "message-b8-authorized-user"],
            )
            .unwrap();
        let before =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(before.call_attempts.len(), 2);
        assert!(before.call_attempts[1].authorized_file_refs.is_empty());
        assert!(before.retry_regenerate.attachment_reauthorization_required);
        assert!(!before.retry_regenerate.retry_eligible);

        let mut retry = retry_regenerate_input(
            "attempt-b8-must-not-exist",
            AIChatAttemptActionIntent::Retry,
            "message-b8-authorized-user",
            "attempt-b8-latest-empty",
            None,
            "2026-08-14T12:00:04.000Z",
        );
        retry.context_source_refs
            .as_array_mut()
            .and_then(|refs| refs.iter_mut().find(|value| is_a3_constraint_source_ref(value)))
            .expect("constraint ref")
            .as_object_mut()
            .expect("constraint ref object")
            .insert(
                "legacySourceMarker".to_string(),
                serde_json::json!("PRE_A3_ORDINARY_CHAT_SOURCE"),
            );
        let error = prepare_ai_retry_regenerate_attempt_in_connection(&mut connection, &retry)
            .expect_err("any older authorization must block direct Retry");
        assert!(
            error.contains("retry_regenerate_attachment_reauthorization_required"),
            "{error}"
        );
        let attempt_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM ai_call_attempts", [], |row| row.get(0))
            .unwrap();
        let authorization_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM ai_call_attempt_file_ref_authorizations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempt_count, 2);
        assert_eq!(authorization_count, 1);

        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn a5_approve_is_atomic_single_flight_restart_readable_and_recovers_original_question() {
        let path = temporary_database_path("a5-approve-durable");
        let mut connection = open_current_database(&path);
        let seeded_path = seed_file_ref(
            &connection,
            &path,
            "file-ref-a5-body",
            "file",
            true,
            "context-notes.txt",
        );
        let text_path = path
            .parent()
            .expect("database parent")
            .join("context-notes.txt");
        std::fs::write(&text_path, b"authorized task-local A5 fixture")
            .expect("write supported text fixture");
        let text_path_value = text_path.to_string_lossy().to_string();
        connection
            .execute(
                "UPDATE file_refs SET path=?1,path_identity_key=?1 WHERE id='file-ref-a5-body'",
                [&text_path_value],
            )
            .expect("point FileRef at supported text fixture");
        std::fs::remove_file(seeded_path).expect("remove superseded fixture path");

        let source_prepare = prepare_input(
            "attempt-a5-source",
            "attempt-a5-source",
            "message-a5-user",
            "2026-08-15T12:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &source_prepare).unwrap();
        let candidate = file_body_context_request_candidate("file-ref-a5-body");
        let requested_refs = serde_json::json!([{
            "refKind": "FILE_REF",
            "refId": "file-ref-a5-body",
            "contributionKind": "BODY_CONTENT"
        }]);
        let requestable_refs = serde_json::json!([{
            "refKind": "FILE_REF",
            "refId": "file-ref-a5-body",
            "projectId": "project-1",
            "label": "context-notes.txt",
            "entityType": "fileRef",
            "allowedContributionKinds": ["IDENTITY_METADATA", "BODY_CONTENT"]
        }]);
        let pending = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &context_request_success_input(
                "attempt-a5-source",
                "message-a5-source-assistant",
                "context-request-a5",
                requested_refs,
                serde_json::json!([candidate.clone()]),
                requestable_refs,
                "2026-08-15T12:00:01.000Z",
            ),
        )
        .unwrap();
        assert_eq!(pending.context_requests.len(), 1);
        assert_eq!(pending.context_requests[0].state, "PENDING");
        assert_eq!(
            pending.context_requests[0].source_message_id,
            "message-a5-source-assistant"
        );
        assert_eq!(
            pending.context_requests[0].source_call_attempt_id,
            "attempt-a5-source"
        );
        let source_before: (String, String, Option<String>) = connection
            .query_row(
                "SELECT message.content,attempt.status,attempt.result_message_id
                 FROM ai_messages message JOIN ai_call_attempts attempt
                   ON attempt.id='attempt-a5-source'
                 WHERE message.id='message-a5-source-assistant'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        let missing_authorization = context_request_followup_input(
            "context-request-a5",
            "message-a5-approve-action-missing",
            "attempt-a5-followup-missing",
            serde_json::json!([candidate.clone()]),
            Vec::new(),
            "2026-08-15T12:00:02.000Z",
        );
        let error = prepare_ai_context_request_followup_in_connection(
            &mut connection,
            &missing_authorization,
        )
        .expect_err("BODY_CONTENT must require an exact explicit per-call authorization");
        assert!(error.contains("AI_CONTEXT_REQUEST_BODY_AUTHORIZATION_REQUIRED"));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM ai_call_attempts", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );

        let approve = context_request_followup_input(
            "context-request-a5",
            "message-a5-approve-action",
            "attempt-a5-followup",
            serde_json::json!([candidate.clone()]),
            vec!["file-ref-a5-body".into()],
            "2026-08-15T12:00:03.000Z",
        );
        let prepared =
            prepare_ai_context_request_followup_in_connection(&mut connection, &approve).unwrap();
        assert!(prepared.provider_invocation_authorized);
        assert_eq!(prepared.readback.call_attempts.len(), 2);
        assert_eq!(prepared.readback.messages.len(), 3);
        assert!(prepared
            .readback
            .projected_messages
            .iter()
            .all(|message| message.message_kind == "text"));
        let request = &prepared.readback.context_requests[0];
        assert_eq!(request.state, "APPROVED");
        assert_eq!(request.decision_type.as_deref(), Some("APPROVE"));
        assert_eq!(
            request.decision_action_message_id.as_deref(),
            Some("message-a5-approve-action")
        );
        assert_eq!(
            request.followup_call_attempt_id.as_deref(),
            Some("attempt-a5-followup")
        );
        assert_eq!(
            prepared.readback.call_attempts[1].trigger_message_id.as_deref(),
            Some("message-a5-approve-action")
        );
        assert_eq!(
            prepared.readback.call_attempts[1]
                .trigger_call_attempt_id
                .as_deref(),
            Some("attempt-a5-source")
        );
        assert_eq!(prepared.readback.call_attempts[1].authorized_file_refs.len(), 1);
        let material = read_authorized_material_selection_in_connection(
            &connection,
            "attempt-a5-followup",
            CURRENT_CONVERSATION_ID,
            "message-a5-approve-action",
        )
        .expect("the canonical material reader must recover the real user question through the action");
        assert_eq!(material.trigger_message_content, "question-message-a5-user");
        assert!(material.context_request_followup);
        assert_eq!(material.files.len(), 1);
        assert_eq!(material.files[0].path, text_path_value);
        assert_eq!(
            frozen_constraint_source_ref(&material.context_source_refs)
                .get("boundedPolicyDocuments")
                .cloned(),
            Some(serde_json::json!([{
                "documentId": "labpod.ai.policy.context_request",
                "semanticVersion": 3
            }]))
        );

        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a5-followup",
                "message-a5-followup-assistant",
                "2026-08-15T12:00:04.000Z",
            ),
        )
        .unwrap();
        let duplicate = prepare_ai_context_request_followup_in_connection(&mut connection, &approve)
            .expect_err("a terminal Context Request cannot create a second follow-up");
        assert!(duplicate.contains("AI_CONTEXT_REQUEST_TERMINAL_CONFLICT"));
        let reject_after_approve = reject_ai_context_request_in_connection(
            &mut connection,
            &DecideAIContextRequestInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                context_request_id: "context-request-a5".into(),
                action_message_id: "message-a5-reject-after-approve".into(),
                decided_at: "2026-08-15T12:00:05.000Z".into(),
            },
        )
        .expect_err("Approve/Reject race must have exactly one winning terminal decision");
        assert!(reject_after_approve.contains("AI_CONTEXT_REQUEST_TERMINAL_CONFLICT"));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM ai_call_attempts", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM ai_messages WHERE message_kind='context_request_action'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        let immutable_error = connection
            .execute(
                "UPDATE ai_context_requests SET decision_reason='mutation forbidden'
                 WHERE id='context-request-a5'",
                [],
            )
            .expect_err("terminal Context Request rows are immutable");
        assert!(immutable_error
            .to_string()
            .contains("AI_CONTEXT_REQUEST_TERMINAL_IMMUTABLE"));
        let source_after: (String, String, Option<String>) = connection
            .query_row(
                "SELECT message.content,attempt.status,attempt.result_message_id
                 FROM ai_messages message JOIN ai_call_attempts attempt
                   ON attempt.id='attempt-a5-source'
                 WHERE message.id='message-a5-source-assistant'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(source_after, source_before);
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let restarted =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(restarted.context_requests.len(), 1);
        assert_eq!(restarted.context_requests[0].state, "APPROVED");
        assert_eq!(restarted.call_attempts.len(), 2);
        assert_eq!(restarted.messages.len(), 4);
        assert!(restarted
            .projected_messages
            .iter()
            .all(|message| message.message_kind == "text"));
        assert_eq!(
            restarted
                .messages
                .iter()
                .filter(|message| message.message_kind == "context_request_action")
                .count(),
            1
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn a5_reject_is_durable_has_zero_automatic_attempts_and_leaves_conversation_usable() {
        let path = temporary_database_path("a5-reject-durable");
        let mut connection = open_current_database(&path);
        let candidate = identity_context_request_candidate();
        prepare_ai_call_attempt_in_connection(
            &mut connection,
            &prepare_input(
                "attempt-a5-reject-source",
                "attempt-a5-reject-source",
                "message-a5-reject-user",
                "2026-08-15T13:00:00.000Z",
            ),
        )
        .unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &context_request_success_input(
                "attempt-a5-reject-source",
                "message-a5-reject-assistant",
                "context-request-a5-reject",
                serde_json::json!([{
                    "refKind": "AI_RESEARCH_OBJECT",
                    "refId": "task-2",
                    "contributionKind": "IDENTITY_METADATA"
                }]),
                serde_json::json!([candidate]),
                serde_json::json!([{
                    "refKind": "AI_RESEARCH_OBJECT",
                    "refId": "task-2",
                    "projectId": "project-1",
                    "label": "Task Two",
                    "entityType": "task",
                    "allowedContributionKinds": ["IDENTITY_METADATA"]
                }]),
                "2026-08-15T13:00:01.000Z",
            ),
        )
        .unwrap();
        let rejected = reject_ai_context_request_in_connection(
            &mut connection,
            &DecideAIContextRequestInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                context_request_id: "context-request-a5-reject".into(),
                action_message_id: "message-a5-reject-action".into(),
                decided_at: "2026-08-15T13:00:02.000Z".into(),
            },
        )
        .unwrap();
        assert_eq!(rejected.context_requests[0].state, "REJECTED");
        assert_eq!(rejected.context_requests[0].decision_type.as_deref(), Some("REJECT"));
        assert_eq!(rejected.call_attempts.len(), 1);
        assert!(rejected.call_attempts[0].authorized_file_refs.is_empty());
        assert_eq!(
            rejected
                .messages
                .iter()
                .filter(|message| message.message_kind == "context_request_action")
                .count(),
            1
        );
        let duplicate = reject_ai_context_request_in_connection(
            &mut connection,
            &DecideAIContextRequestInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                context_request_id: "context-request-a5-reject".into(),
                action_message_id: "message-a5-reject-action-duplicate".into(),
                decided_at: "2026-08-15T13:00:03.000Z".into(),
            },
        )
        .expect_err("duplicate Reject must add no side effect");
        assert!(duplicate.contains("AI_CONTEXT_REQUEST_TERMINAL_CONFLICT"));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM ai_call_attempts", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM ai_messages WHERE message_kind='context_request_action'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );

        let next = prepare_input(
            "attempt-a5-after-reject",
            "attempt-a5-after-reject",
            "message-a5-after-reject-user",
            "2026-08-15T13:00:04.000Z",
        );
        let prepared = prepare_ai_call_attempt_in_connection(&mut connection, &next).unwrap();
        assert!(prepared.provider_invocation_authorized);
        assert_eq!(prepared.readback.call_attempts.len(), 2);
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a5-after-reject",
                "message-a5-after-reject-assistant",
                "2026-08-15T13:00:05.000Z",
            ),
        )
        .unwrap();
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let restarted =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(restarted.context_requests[0].state, "REJECTED");
        assert_eq!(restarted.call_attempts.len(), 2);
        assert_eq!(restarted.call_attempts[1].status, "succeeded");
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn a5_superseded_source_and_changed_review_fail_before_followup_mutation() {
        let path = temporary_database_path("a5-stale-guards");
        let mut connection = open_current_database(&path);
        let candidate = identity_context_request_candidate();
        prepare_ai_call_attempt_in_connection(
            &mut connection,
            &prepare_input(
                "attempt-a5-stale-source",
                "attempt-a5-stale-source",
                "message-a5-stale-user",
                "2026-08-15T14:00:00.000Z",
            ),
        )
        .unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &context_request_success_input(
                "attempt-a5-stale-source",
                "message-a5-stale-assistant",
                "context-request-a5-stale",
                serde_json::json!([{
                    "refKind": "AI_RESEARCH_OBJECT",
                    "refId": "task-2",
                    "contributionKind": "IDENTITY_METADATA"
                }]),
                serde_json::json!([candidate.clone()]),
                serde_json::json!([{
                    "refKind": "AI_RESEARCH_OBJECT",
                    "refId": "task-2",
                    "projectId": "project-1",
                    "label": "Task Two",
                    "entityType": "task",
                    "allowedContributionKinds": ["IDENTITY_METADATA"]
                }]),
                "2026-08-15T14:00:01.000Z",
            ),
        )
        .unwrap();

        let changed = serde_json::json!([{
            "refKind": "AI_RESEARCH_OBJECT",
            "refId": "task-2",
            "entityType": "task",
            "projectId": "project-1",
            "label": "Changed canonical title",
            "contributionKind": "IDENTITY_METADATA",
            "availability": "available",
            "fileBodyAuthorizationRequired": false,
            "proposedContribution": "Task identity for one follow-up call."
        }]);
        let changed_error = prepare_ai_context_request_followup_in_connection(
            &mut connection,
            &context_request_followup_input(
                "context-request-a5-stale",
                "message-a5-changed-action",
                "attempt-a5-changed-followup",
                changed,
                Vec::new(),
                "2026-08-15T14:00:02.000Z",
            ),
        )
        .expect_err("candidate changes require a new review");
        assert!(changed_error.contains("AI_CONTEXT_REQUEST_REVIEW_MISMATCH"));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM ai_call_attempts", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );

        prepare_ai_call_attempt_in_connection(
            &mut connection,
            &prepare_input(
                "attempt-a5-superseding",
                "attempt-a5-superseding",
                "message-a5-superseding-user",
                "2026-08-15T14:00:03.000Z",
            ),
        )
        .unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a5-superseding",
                "message-a5-superseding-assistant",
                "2026-08-15T14:00:04.000Z",
            ),
        )
        .unwrap();
        let stale_error = prepare_ai_context_request_followup_in_connection(
            &mut connection,
            &context_request_followup_input(
                "context-request-a5-stale",
                "message-a5-stale-action",
                "attempt-a5-stale-followup",
                serde_json::json!([candidate]),
                Vec::new(),
                "2026-08-15T14:00:05.000Z",
            ),
        )
        .expect_err("a superseded source cannot be approved");
        assert!(stale_error.contains("AI_CONTEXT_REQUEST_STALE"));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM ai_call_attempts", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM ai_messages WHERE message_kind='context_request_action'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        let stale = mark_ai_context_request_stale_in_connection(
            &mut connection,
            &MarkAIContextRequestStaleInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                context_request_id: "context-request-a5-stale".into(),
                reason: "Source superseded by a newer canonical result.".into(),
                decided_at: "2026-08-15T14:00:06.000Z".into(),
            },
        )
        .unwrap();
        assert_eq!(stale.context_requests[0].state, "STALE_OR_INVALID");
        assert_eq!(stale.context_requests[0].decision_type.as_deref(), Some("STALE"));
        assert_eq!(stale.call_attempts.len(), 2);
        assert_eq!(
            stale
                .messages
                .iter()
                .filter(|message| message.message_kind == "context_request_action")
                .count(),
            0
        );
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    fn parse_constraint_source_refs(message_id: &str) -> Value {
        serde_json::json!([
            {
                "module": "ai",
                "entityType": "system",
                "entityId": "labpod.ai.constraint.parse_draft",
                "field": "constraintDescriptor",
                "sourceKind": "systemGenerated",
                "constraintCategory": "PARSE_DRAFT",
                "constraintLifecycle": "ACTIVE",
                "constraintRef": "labpod.ai.constraint.parse_draft",
                "constraintVersion": 3,
                "sharedInvariantRef": "labpod.ai.constraint.shared_invariant",
                "sharedInvariantVersion": 2,
                "boundedPolicyRefs": [],
                "boundedPolicyDocuments": [{
                    "documentId": "labpod.ai.policy.context_request",
                    "semanticVersion": 3
                }]
            },
            {
                "module": "ai",
                "entityType": "system",
                "entityId": "discussion-a6",
                "field": "relevantEffectiveDiscussion",
                "sourceKind": "systemGenerated",
                "parseDiscussionFingerprint": "discussion-fingerprint-a6",
                "parseDiscussionMessageIds": [message_id],
                "parseProjectId": "project-1",
                "parseTaskIds": ["task-1"],
                "parseContextReviewFingerprint": "context-review-a6",
                "parseContextMode": "STANDARD_CONTEXT"
            }
        ])
    }

    fn parse_source_snapshot(trigger_message_id: &str) -> Value {
        serde_json::json!({
            "conversationId": CURRENT_CONVERSATION_ID,
            "projectId": "project-1",
            "selectedRouteIds": [],
            "selectedTaskIds": ["task-1"],
            "selectedReviewIds": [],
            "selectedExperimentIds": [],
            "selectedExperimentRunIds": [],
            "experimentRunParentRelations": [],
            "selectedLiteratureIds": [],
            "literatureAssociationTuples": [],
            "literatureSelectionAggregateEligibility": "ALLOWED",
            "contextMode": "STANDARD_CONTEXT",
            "contextBudget": {
                "maxChars": 12000,
                "reservedForUserQuestion": 1200,
                "reservedForSystemInstruction": 1200,
                "strategy": "priorityFirst"
            },
            "contextReviewFingerprint": "context-review-a6",
            "authorizedMaterialFileRefIds": [],
            "approvedContextRequestContributions": [],
            "discussionFingerprint": "discussion-fingerprint-a6",
            "discussionMessages": [{
                "id": trigger_message_id,
                "sequence": 1,
                "role": "user"
            }],
            "firstMessageId": trigger_message_id,
            "lastMessageId": trigger_message_id,
            "triggerMessageId": trigger_message_id
        })
    }

    fn prepare_parse_attempt_input(attempt_id: &str, trigger_message_id: &str, at: &str) -> PrepareAICallAttemptInput {
        PrepareAICallAttemptInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            attempt_id: attempt_id.into(),
            request_id: attempt_id.into(),
            purpose: "parse_draft".into(),
            user_message: None,
            trigger_message_id: Some(trigger_message_id.into()),
            trigger_call_attempt_id: None,
            provider: "deepseek".into(),
            model: "deepseek-v4-flash".into(),
            context_package_id: format!("context-{attempt_id}"),
            context_package_version: "ai-lp13-b1-a2-v1".into(),
            context_source_refs: parse_constraint_source_refs(trigger_message_id),
            warnings: serde_json::json!([]),
            budget_summary: Some(serde_json::json!({"maxChars":12000,"usedChars":7000})),
            prompt_package_id: format!("prompt-{attempt_id}"),
            prompt_created_at: at.into(),
            started_at: at.into(),
            authorized_file_ref_ids: Vec::new(),
        }
    }

    fn prepare_route_literature_delete_parse_attempt_input(
        attempt_id: &str,
        trigger_message_id: &str,
        at: &str,
    ) -> PrepareAICallAttemptInput {
        let mut input = prepare_parse_attempt_input(attempt_id, trigger_message_id, at);
        let source_refs = input
            .context_source_refs
            .as_array_mut()
            .expect("D1-F1-A1 Parse Context source refs");
        let discussion_ref = source_refs
            .iter_mut()
            .find(|source_ref| {
                source_ref.get("field").and_then(Value::as_str)
                    == Some("relevantEffectiveDiscussion")
            })
            .expect("D1-F1-A1 relevant effective discussion ref");
        discussion_ref["parseProjectId"] = serde_json::json!("project-1");
        discussion_ref["parseRouteIds"] = serde_json::json!(["route-1"]);
        discussion_ref["parseTaskIds"] = serde_json::json!([]);
        discussion_ref["parseLiteratureIds"] = serde_json::json!(["literature-1"]);
        discussion_ref["parseLiteratureAssociationTuples"] = serde_json::json!([{
            "literatureId":"literature-1","projectAssociationKind":"assigned",
            "canonicalProjectId":"project-1","lifecycleEligibility":"eligible",
            "conversationProjectEligibilityDisposition":"allowed_same_project",
            "selectionOrder":0,"normalizedProjectionFingerprint":"literature-safe-d1-f1-a1"
        }]);
        discussion_ref["parseLiteratureSelectionAggregateEligibility"] =
            serde_json::json!("ALLOWED");
        source_refs.push(serde_json::json!({
            "module":"project","entityType":"project","entityId":"project-1",
            "contextDisposition":"included","contextRole":"scope","isVerified":false
        }));
        source_refs.push(serde_json::json!({
            "module":"route","entityType":"routeNode","entityId":"route-1",
            "contextDisposition":"included","contextRole":"primary","isVerified":true
        }));
        source_refs.push(serde_json::json!({
            "module":"literature","entityType":"literature","entityId":"literature-1",
            "contextDisposition":"included","contextRole":"primary","isVerified":true
        }));
        input
    }

    fn standard_result_batch(trigger_message_id: &str, at: &str) -> NewAIStandardResultBatchInput {
        NewAIStandardResultBatchInput {
            id: "standard-result-batch-a6".into(),
            results: vec![
                NewAIStandardResultInput {
                    id: "standard-result-create-a6".into(),
                    ordinal: 1,
                    category: "DATA_OPERATION".into(),
                    action: "CREATE".into(),
                    target: serde_json::json!({
                        "module":"task","projectId":"project-1","entityType":"task"
                    }),
                    source: parse_source_snapshot(trigger_message_id),
                    original_payload: serde_json::json!({"title":"Create from discussion"}),
                    visible_payload: serde_json::json!({"title":"Create from discussion"}),
                    visible_payload_fingerprint: "visible-create-a6-v1".into(),
                    target_snapshot_fingerprint: None,
                    validation_issues: serde_json::json!([]),
                },
                NewAIStandardResultInput {
                    id: "standard-result-delete-a6".into(),
                    ordinal: 2,
                    category: "DATA_OPERATION".into(),
                    action: "DELETE_SUGGESTION".into(),
                    target: serde_json::json!({
                        "module":"task","projectId":"project-1","entityType":"task",
                        "entityId":"task-1"
                    }),
                    source: parse_source_snapshot(trigger_message_id),
                    original_payload: serde_json::json!({"reason":"No longer relevant"}),
                    visible_payload: serde_json::json!({"reason":"No longer relevant"}),
                    visible_payload_fingerprint: "visible-delete-a6-v1".into(),
                    target_snapshot_fingerprint: Some("task-snapshot-a6".into()),
                    validation_issues: serde_json::json!([{
                        "code":"DELETE_SUGGESTION_INFORMATIONAL_ONLY",
                        "message":"No delete executor."
                    }]),
                },
            ],
            created_at: at.into(),
        }
    }

    fn a16_finding_standard_result_batch(
        trigger_message_id: &str,
        at: &str,
    ) -> NewAIStandardResultBatchInput {
        let mut batch = standard_result_batch(trigger_message_id, at);
        batch.id = "standard-result-batch-finding-a16".into();
        batch.results.truncate(1);
        let result = &mut batch.results[0];
        result.id = "standard-result-finding-a16".into();
        result.target = serde_json::json!({
            "module":"finding","projectId":"project-1","entityType":"finding"
        });
        result.original_payload = serde_json::json!({
            "title":"A16 exact Finding",
            "summary":"Bounded durable parity fixture",
            "findingType":"evidence",
            "confidence":"medium",
            "maturity":"low",
            "tags":["a16"],
            "routeId":null,
            "taskId":null,
            "experimentId":null,
            "resultItemIds":[]
        });
        result.visible_payload = result.original_payload.clone();
        result.visible_payload_fingerprint = "visible-finding-a16-v1".into();
        result.target_snapshot_fingerprint = None;
        result.validation_issues = serde_json::json!([]);
        batch
    }

    fn a7_review_standard_result_batch(
        trigger_message_id: &str,
        at: &str,
    ) -> NewAIStandardResultBatchInput {
        let mut source = parse_source_snapshot(trigger_message_id);
        source["selectedReviewIds"] = serde_json::json!(["review-1"]);
        NewAIStandardResultBatchInput {
            id: "standard-result-batch-a7".into(),
            results: vec![
                NewAIStandardResultInput {
                    id: "standard-result-review-create-a7".into(),
                    ordinal: 1,
                    category: "DATA_OPERATION".into(),
                    action: "CREATE".into(),
                    target: serde_json::json!({
                        "module":"review","projectId":"project-1","entityType":"review"
                    }),
                    source: source.clone(),
                    original_payload: serde_json::json!({
                        "title":"Review created from discussion",
                        "reviewType":"stage",
                        "periodStart":"2026-08-01",
                        "periodEnd":"2026-08-15",
                        "summary":"Evidence-backed summary"
                    }),
                    visible_payload: serde_json::json!({
                        "title":"Review created from discussion",
                        "reviewType":"stage",
                        "periodStart":"2026-08-01",
                        "periodEnd":"2026-08-15",
                        "summary":"Evidence-backed summary"
                    }),
                    visible_payload_fingerprint: "visible-review-create-a7-v1".into(),
                    target_snapshot_fingerprint: None,
                    validation_issues: serde_json::json!([]),
                },
                NewAIStandardResultInput {
                    id: "standard-result-review-manuscript-a7".into(),
                    ordinal: 2,
                    category: "MANUSCRIPT_RESULT".into(),
                    action: "NEW_MANUSCRIPT".into(),
                    target: serde_json::json!({
                        "module":"review","projectId":"project-1","entityType":"review",
                        "entityId":"review-1","manuscriptChannel":"primary"
                    }),
                    source: source.clone(),
                    original_payload: serde_json::json!({"body":"# Candidate\n\nBody"}),
                    visible_payload: serde_json::json!({"body":"# Candidate\n\nBody"}),
                    visible_payload_fingerprint: "visible-review-manuscript-a7-v1".into(),
                    target_snapshot_fingerprint: Some("review-snapshot-a7".into()),
                    validation_issues: serde_json::json!([]),
                },
                NewAIStandardResultInput {
                    id: "standard-result-review-update-a7".into(),
                    ordinal: 3,
                    category: "DATA_OPERATION".into(),
                    action: "UPDATE".into(),
                    target: serde_json::json!({
                        "module":"review","projectId":"project-1","entityType":"review",
                        "entityId":"review-1"
                    }),
                    source,
                    original_payload: serde_json::json!({
                        "outlineSections":[{"key":"stage_summary","content":"2"}]
                    }),
                    visible_payload: serde_json::json!({
                        "outlineSections":[{"key":"stage_summary","content":"2"}]
                    }),
                    visible_payload_fingerprint: "visible-review-update-a7-v1".into(),
                    target_snapshot_fingerprint: Some("review-snapshot-update-a7".into()),
                    validation_issues: serde_json::json!([]),
                },
            ],
            created_at: at.into(),
        }
    }

    fn a10_experiment_standard_result_batch(
        trigger_message_id: &str,
        at: &str,
    ) -> NewAIStandardResultBatchInput {
        let mut source = parse_source_snapshot(trigger_message_id);
        source["selectedExperimentIds"] = serde_json::json!(["experiment-1"]);
        let result = |id: &str,
                      ordinal: i64,
                      category: &str,
                      action: &str,
                      target: Value,
                      payload: Value,
                      fingerprint: &str,
                      issues: Value| NewAIStandardResultInput {
            id: id.into(),
            ordinal,
            category: category.into(),
            action: action.into(),
            target,
            source: if action == "CREATE" {
                let mut create_source = source.clone();
                create_source["selectedExperimentIds"] = serde_json::json!([]);
                create_source
            } else {
                source.clone()
            },
            original_payload: payload.clone(),
            visible_payload: payload,
            visible_payload_fingerprint: fingerprint.into(),
            target_snapshot_fingerprint: if action == "CREATE" {
                None
            } else {
                Some("experiment-snapshot-a10".into())
            },
            validation_issues: issues,
        };
        NewAIStandardResultBatchInput {
            id: "standard-result-batch-a10".into(),
            results: vec![
                result(
                    "standard-result-experiment-create-a10",
                    1,
                    "DATA_OPERATION",
                    "CREATE",
                    serde_json::json!({
                        "module":"experiment","projectId":"project-1","entityType":"experiment"
                    }),
                    serde_json::json!({"title":"Create Experiment","status":"planned"}),
                    "visible-experiment-create-a10-v1",
                    serde_json::json!([]),
                ),
                result(
                    "standard-result-experiment-update-a10",
                    2,
                    "DATA_OPERATION",
                    "UPDATE",
                    serde_json::json!({
                        "module":"experiment","projectId":"project-1","entityType":"experiment",
                        "entityId":"experiment-1"
                    }),
                    serde_json::json!({"title":"Update Experiment"}),
                    "visible-experiment-update-a10-v1",
                    serde_json::json!([]),
                ),
                result(
                    "standard-result-experiment-delete-a10",
                    3,
                    "DATA_OPERATION",
                    "DELETE_SUGGESTION",
                    serde_json::json!({
                        "module":"experiment","projectId":"project-1","entityType":"experiment",
                        "entityId":"experiment-1"
                    }),
                    serde_json::json!({"reason":"Review manually"}),
                    "visible-experiment-delete-a10-v1",
                    serde_json::json!([{"code":"DELETE_SUGGESTION_INFORMATIONAL_ONLY","message":"No executor"}]),
                ),
                result(
                    "standard-result-experiment-manuscript-a10",
                    4,
                    "MANUSCRIPT_RESULT",
                    "NEW_MANUSCRIPT",
                    serde_json::json!({
                        "module":"experiment","projectId":"project-1","entityType":"experiment",
                        "entityId":"experiment-1","manuscriptChannel":"primary"
                    }),
                    serde_json::json!({"body":"Out of scope"}),
                    "visible-experiment-manuscript-a10-v1",
                    serde_json::json!([{"code":"EXPERIMENT_NEW_MANUSCRIPT_NOT_ENABLED_IN_A10","message":"No executor"}]),
                ),
            ],
            created_at: at.into(),
        }
    }

    fn a11_experiment_manuscript_standard_result_batch(
        trigger_message_id: &str,
        at: &str,
    ) -> NewAIStandardResultBatchInput {
        let mut source = parse_source_snapshot(trigger_message_id);
        source["selectedExperimentIds"] = serde_json::json!(["experiment-1"]);
        let result = |id: &str, ordinal: i64, target: Value| NewAIStandardResultInput {
            id: id.into(),
            ordinal,
            category: "MANUSCRIPT_RESULT".into(),
            action: "NEW_MANUSCRIPT".into(),
            target,
            source: source.clone(),
            original_payload: serde_json::json!({"body":"# Edited A11 body"}),
            visible_payload: serde_json::json!({"body":"# Edited A11 body"}),
            visible_payload_fingerprint: format!("visible-{id}-v1"),
            target_snapshot_fingerprint: Some("experiment-primary-snapshot-a11".into()),
            validation_issues: serde_json::json!([]),
        };
        NewAIStandardResultBatchInput {
            id: "standard-result-batch-a11".into(),
            results: vec![result(
                "standard-result-experiment-manuscript-a11",
                1,
                serde_json::json!({
                    "module":"experiment","projectId":"project-1","entityType":"experiment",
                    "entityId":"experiment-1","manuscriptChannel":"primary"
                }),
            )],
            created_at: at.into(),
        }
    }

    fn a13_experiment_run_standard_result_batch(
        trigger_message_id: &str,
        at: &str,
    ) -> NewAIStandardResultBatchInput {
        let mut source = parse_source_snapshot(trigger_message_id);
        source["selectedTaskIds"] = serde_json::json!([]);
        source["selectedExperimentRunIds"] = serde_json::json!(["run-1"]);
        source["experimentRunParentRelations"] = serde_json::json!([{
            "runId":"run-1","parentExperimentId":"experiment-1",
            "projectId":"project-1","selectionOrder":0
        }]);
        let result = |id: &str,
                      ordinal: i64,
                      category: &str,
                      action: &str,
                      target: Value,
                      payload: Value,
                      fingerprint: &str,
                      issues: Value| NewAIStandardResultInput {
            id: id.into(),
            ordinal,
            category: category.into(),
            action: action.into(),
            target,
            source: source.clone(),
            original_payload: payload.clone(),
            visible_payload: payload,
            visible_payload_fingerprint: fingerprint.into(),
            target_snapshot_fingerprint: Some(format!("run-snapshot-a13-{ordinal}")),
            validation_issues: issues,
        };
        NewAIStandardResultBatchInput {
            id: "standard-result-batch-a13".into(),
            results: vec![
                result(
                    "standard-result-run-create-a13",
                    1,
                    "DATA_OPERATION",
                    "CREATE",
                    serde_json::json!({
                        "module":"experimentRun","projectId":"project-1","entityType":"experimentRun",
                        "parentExperimentId":"experiment-1","parentExperimentLabel":"Experiment 1",
                        "projectLabel":"Project 1"
                    }),
                    serde_json::json!({"title":"Create Run","status":"planned"}),
                    "visible-run-create-a13-v1",
                    serde_json::json!([]),
                ),
                result(
                    "standard-result-run-update-a13",
                    2,
                    "DATA_OPERATION",
                    "UPDATE",
                    serde_json::json!({
                        "module":"experimentRun","projectId":"project-1","entityType":"experimentRun",
                        "entityId":"run-1","parentExperimentId":"experiment-1",
                        "parentExperimentLabel":"Experiment 1","projectLabel":"Project 1",
                        "expectedUpdatedAt":"2026-08-16T01:01:00.000Z"
                    }),
                    serde_json::json!({"title":"Update Run"}),
                    "visible-run-update-a13-v1",
                    serde_json::json!([]),
                ),
                result(
                    "standard-result-run-delete-a13",
                    3,
                    "DATA_OPERATION",
                    "DELETE_SUGGESTION",
                    serde_json::json!({
                        "module":"experimentRun","projectId":"project-1","entityType":"experimentRun",
                        "entityId":"run-1","parentExperimentId":"experiment-1",
                        "parentExperimentLabel":"Experiment 1","projectLabel":"Project 1"
                    }),
                    serde_json::json!({"reason":"Manual review only"}),
                    "visible-run-delete-a13-v1",
                    serde_json::json!([{"code":"DELETE_SUGGESTION_INFORMATIONAL_ONLY","message":"No executor"}]),
                ),
                result(
                    "standard-result-run-manuscript-a13",
                    4,
                    "MANUSCRIPT_RESULT",
                    "NEW_MANUSCRIPT",
                    serde_json::json!({
                        "module":"experimentRun","projectId":"project-1","entityType":"experimentRun",
                        "entityId":"run-1","parentExperimentId":"experiment-1",
                        "parentExperimentLabel":"Experiment 1","projectLabel":"Project 1",
                        "manuscriptChannel":"primary"
                    }),
                    serde_json::json!({"body":"Out of scope"}),
                    "visible-run-manuscript-a13-v1",
                    serde_json::json!([{"code":"EXPERIMENT_RUN_NEW_MANUSCRIPT_NOT_ENABLED_IN_A13","message":"No executor"}]),
                ),
            ],
            created_at: at.into(),
        }
    }

    fn a14_experiment_run_manuscript_standard_result_batch(
        trigger_message_id: &str,
        at: &str,
    ) -> NewAIStandardResultBatchInput {
        let mut source = parse_source_snapshot(trigger_message_id);
        source["selectedTaskIds"] = serde_json::json!([]);
        source["selectedExperimentRunIds"] = serde_json::json!(["run-1"]);
        source["experimentRunParentRelations"] = serde_json::json!([{
            "runId":"run-1","parentExperimentId":"experiment-1",
            "projectId":"project-1","selectionOrder":0
        }]);
        NewAIStandardResultBatchInput {
            id: "standard-result-batch-a14".into(),
            results: vec![NewAIStandardResultInput {
                id: "standard-result-run-manuscript-a14".into(),
                ordinal: 1,
                category: "MANUSCRIPT_RESULT".into(),
                action: "NEW_MANUSCRIPT".into(),
                target: serde_json::json!({
                    "module":"experimentRun","projectId":"project-1",
                    "entityType":"experimentRun","entityId":"run-1",
                    "manuscriptChannel":"primary","parentExperimentId":"experiment-1",
                    "parentExperimentLabel":"Experiment 1","projectLabel":"Project 1"
                }),
                source,
                original_payload: serde_json::json!({"body":"# Edited A14 Run body"}),
                visible_payload: serde_json::json!({"body":"# Edited A14 Run body"}),
                visible_payload_fingerprint: "visible-run-manuscript-a14-v1".into(),
                target_snapshot_fingerprint: Some("run-primary-snapshot-a14".into()),
                validation_issues: serde_json::json!([]),
            }],
            created_at: at.into(),
        }
    }

    fn a16_literature_standard_result_batch(
        trigger_message_id: &str,
        at: &str,
    ) -> NewAIStandardResultBatchInput {
        let mut source = parse_source_snapshot(trigger_message_id);
        source["selectedTaskIds"] = serde_json::json!([]);
        source["selectedLiteratureIds"] = serde_json::json!(["literature-1"]);
        source["literatureAssociationTuples"] = serde_json::json!([{
            "literatureId":"literature-1","projectAssociationKind":"assigned",
            "canonicalProjectId":"project-1","lifecycleEligibility":"eligible",
            "conversationProjectEligibilityDisposition":"allowed_same_project",
            "selectionOrder":0,"normalizedProjectionFingerprint":"literature-safe-a15"
        }]);
        let result = |id: &str,
                      ordinal: i64,
                      action: &str,
                      target: Value,
                      payload: Value,
                      fingerprint: &str| NewAIStandardResultInput {
            id: id.into(),
            ordinal,
            category: "DATA_OPERATION".into(),
            action: action.into(),
            target,
            source: source.clone(),
            original_payload: payload.clone(),
            visible_payload: payload,
            visible_payload_fingerprint: fingerprint.into(),
            target_snapshot_fingerprint: if action == "CREATE" {
                None
            } else {
                Some("literature-snapshot-a16".into())
            },
            validation_issues: serde_json::json!([]),
        };
        NewAIStandardResultBatchInput {
            id: "standard-result-batch-a16".into(),
            results: vec![
                result(
                    "standard-result-literature-create-a16",
                    1,
                    "CREATE",
                    serde_json::json!({
                        "module":"literature","projectId":"project-1",
                        "entityType":"literature","primaryProjectId":null
                    }),
                    serde_json::json!({"title":"Create Literature","authors":[],"keywords":[],"readingStatus":"unread","tags":[]}),
                    "visible-literature-create-a16-v1",
                ),
                result(
                    "standard-result-literature-update-a16",
                    2,
                    "UPDATE",
                    serde_json::json!({
                        "module":"literature","projectId":"project-1",
                        "entityType":"literature","entityId":"literature-1",
                        "primaryProjectId":"project-1",
                        "expectedUpdatedAt":"2026-08-16T20:00:00.000Z"
                    }),
                    serde_json::json!({"title":"Update Literature"}),
                    "visible-literature-update-a16-v1",
                ),
            ],
            created_at: at.into(),
        }
    }

    fn literature_exact_channel_manuscript_standard_result_batch(
        trigger_message_id: &str,
        at: &str,
        channel: &str,
        result_id: &str,
        body: &str,
        visible_payload_fingerprint: &str,
    ) -> NewAIStandardResultBatchInput {
        let mut source = parse_source_snapshot(trigger_message_id);
        source["selectedLiteratureIds"] = serde_json::json!(["literature-1"]);
        source["literatureAssociationTuples"] = serde_json::json!([{
            "literatureId":"literature-1","projectAssociationKind":"assigned",
            "canonicalProjectId":"project-1","lifecycleEligibility":"eligible",
            "conversationProjectEligibilityDisposition":"allowed_same_project",
            "selectionOrder":1,"normalizedProjectionFingerprint":"literature-safe-a17"
        }]);
        NewAIStandardResultBatchInput {
            id: "standard-result-batch-a17".into(),
            results: vec![NewAIStandardResultInput {
                id: result_id.into(),
                ordinal: 1,
                category: "MANUSCRIPT_RESULT".into(),
                action: "NEW_MANUSCRIPT".into(),
                target: serde_json::json!({
                    "module":"literature","projectId":"project-1",
                    "entityType":"literature","entityId":"literature-1",
                    "primaryProjectId":"project-1","manuscriptChannel":channel
                }),
                source,
                original_payload: serde_json::json!({"body":body}),
                visible_payload: serde_json::json!({"body":body}),
                visible_payload_fingerprint: visible_payload_fingerprint.into(),
                target_snapshot_fingerprint: Some(format!("literature-{channel}-snapshot")),
                validation_issues: serde_json::json!([]),
            }],
            created_at: at.into(),
        }
    }

    fn route_literature_delete_standard_result_batch(
        trigger_message_id: &str,
        at: &str,
    ) -> NewAIStandardResultBatchInput {
        let mut source = parse_source_snapshot(trigger_message_id);
        source["selectedRouteIds"] = serde_json::json!(["route-1"]);
        source["selectedTaskIds"] = serde_json::json!([]);
        source["selectedLiteratureIds"] = serde_json::json!(["literature-1"]);
        source["literatureAssociationTuples"] = serde_json::json!([{
            "literatureId":"literature-1","projectAssociationKind":"assigned",
            "canonicalProjectId":"project-1","lifecycleEligibility":"eligible",
            "conversationProjectEligibilityDisposition":"allowed_same_project",
            "selectionOrder":0,"normalizedProjectionFingerprint":"literature-safe-d1-f1-a1"
        }]);
        NewAIStandardResultBatchInput {
            id: "standard-result-batch-d1-f1-a1-route-literature-delete".into(),
            results: vec![
                NewAIStandardResultInput {
                    id: "standard-result-route-delete-d1-f1-a1".into(),
                    ordinal: 1,
                    category: "DATA_OPERATION".into(),
                    action: "DELETE_SUGGESTION".into(),
                    target: serde_json::json!({
                        "module":"route","projectId":"project-1","entityType":"routeNode",
                        "entityId":"route-1"
                    }),
                    source: source.clone(),
                    original_payload: serde_json::json!({
                        "reason":"Return to the Route record and review deletion manually."
                    }),
                    visible_payload: serde_json::json!({
                        "reason":"Return to the Route record and review deletion manually."
                    }),
                    visible_payload_fingerprint: "visible-route-delete-d1-f1-a1-v1".into(),
                    target_snapshot_fingerprint: Some("route-snapshot-d1-f1-a1".into()),
                    validation_issues: serde_json::json!([{
                        "code":"DELETE_SUGGESTION_INFORMATIONAL_ONLY",
                        "message":"No Route delete executor."
                    }]),
                },
                NewAIStandardResultInput {
                    id: "standard-result-literature-delete-d1-f1-a1".into(),
                    ordinal: 2,
                    category: "DATA_OPERATION".into(),
                    action: "DELETE_SUGGESTION".into(),
                    target: serde_json::json!({
                        "module":"literature","projectId":"project-1","entityType":"literature",
                        "entityId":"literature-1","primaryProjectId":"project-1"
                    }),
                    source,
                    original_payload: serde_json::json!({
                        "reason":"Return to the Literature record and review deletion manually."
                    }),
                    visible_payload: serde_json::json!({
                        "reason":"Return to the Literature record and review deletion manually."
                    }),
                    visible_payload_fingerprint: "visible-literature-delete-d1-f1-a1-v1".into(),
                    target_snapshot_fingerprint: Some("literature-snapshot-d1-f1-a1".into()),
                    validation_issues: serde_json::json!([{
                        "code":"DELETE_SUGGESTION_INFORMATIONAL_ONLY",
                        "message":"No Literature delete executor."
                    }]),
                },
            ],
            created_at: at.into(),
        }
    }

    #[test]
    fn lp14_a1_c5_parse_phase_a_can_settle_only_with_exact_workflow_receipt_and_phase_b_remains_linked() {
        let path = temporary_database_path("lp14-a1-c5-parse-supplemental-phase-a");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-c5-chat",
            "attempt-c5-chat",
            "message-c5-user",
            "2026-08-26T12:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-c5-chat",
                "message-c5-assistant",
                "2026-08-26T12:00:01.000Z",
            ),
        )
        .unwrap();

        let mut phase_a = prepare_parse_attempt_input(
            "attempt-c5-phase-a",
            "message-c5-user",
            "2026-08-26T12:00:02.000Z",
        );
        phase_a
            .context_source_refs
            .as_array_mut()
            .expect("C5 Phase-A source refs")
            .push(serde_json::json!({
                "module":"ai",
                "entityType":"system",
                "entityId":"attempt-c5-phase-a",
                "label":"Parse supplemental context workflow",
                "field":"parseSupplementalContextWorkflow",
                "sourceKind":"systemGenerated",
                "isUserAuthored":false,
                "isAiGenerated":false,
                "isVerified":true,
                "parseSupplementalContextWorkflowKind":"PARSE_DRAFT",
                "parseSupplementalContextPhase":"PHASE_A_ELIGIBLE",
                "parseSupplementalContextLogicalAttemptId":"attempt-c5-phase-a",
                "parseSupplementalContextRequestLimit":1,
                "parseSupplementalContextRequestRemaining":1,
                "parseSupplementalContextAutomaticContinuationCount":0
            }));
        prepare_ai_call_attempt_in_connection(&mut connection, &phase_a).unwrap();
        let phase_a_settlement = SettleAICallAttemptSuccessInput {
            attempt_id: "attempt-c5-phase-a".into(),
            provider: "deepseek".into(),
            model: "deepseek-v4-flash".into(),
            response_truncated: Some(false),
            usage: None,
            assistant_message: None,
            context_request: None,
            standard_result_batch: None,
            settled_at: "2026-08-26T12:00:03.000Z".into(),
        };
        let phase_a_readback = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &phase_a_settlement,
        )
        .expect("exact C5 Phase-A provenance admits one childless intermediate success");
        let phase_a_attempt = phase_a_readback
            .call_attempts
            .iter()
            .find(|attempt| attempt.id == "attempt-c5-phase-a")
            .expect("C5 Phase-A readback");
        assert_eq!(phase_a_attempt.status, "succeeded");
        assert!(phase_a_attempt.result_message_id.is_none());
        assert!(phase_a_readback.context_requests.is_empty());
        assert!(phase_a_readback.standard_results.is_empty());
        settle_ai_call_attempt_success_in_connection(&mut connection, &phase_a_settlement)
            .expect("C5 Phase-A settlement is idempotent");

        let mut phase_b = prepare_parse_attempt_input(
            "attempt-c5-phase-b",
            "message-c5-user",
            "2026-08-26T12:00:04.000Z",
        );
        phase_b.trigger_call_attempt_id = Some("attempt-c5-phase-a".into());
        phase_b
            .context_source_refs
            .as_array_mut()
            .expect("C5 Phase-B source refs")
            .push(serde_json::json!({
                "module":"ai",
                "entityType":"system",
                "entityId":"lp14-a1-c5-projection",
                "field":"parseSupplementalContextWorkflow",
                "sourceKind":"systemGenerated",
                "parseSupplementalContextWorkflowKind":"PARSE_DRAFT",
                "parseSupplementalContextPhase":"PHASE_B_AUTOMATIC",
                "parseSupplementalContextLogicalAttemptId":"attempt-c5-phase-a",
                "parseSupplementalContextSourceCallAttemptId":"attempt-c5-phase-a",
                "parseSupplementalContextRequestLimit":1,
                "parseSupplementalContextRequestRemaining":0,
                "parseSupplementalContextAutomaticContinuationCount":1,
                "parseSupplementalContextProjectionFingerprint":"lp14-a1-c5-projection"
            }));
        prepare_ai_call_attempt_in_connection(&mut connection, &phase_b).unwrap();
        let settled = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-c5-phase-b".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(standard_result_batch(
                    "message-c5-user",
                    "2026-08-26T12:00:05.000Z",
                )),
                settled_at: "2026-08-26T12:00:05.000Z".into(),
            },
        )
        .expect("linked C5 Phase B uses the ordinary Standard Result settlement");
        let phase_b_attempt = settled
            .call_attempts
            .iter()
            .find(|attempt| attempt.id == "attempt-c5-phase-b")
            .expect("C5 Phase-B readback");
        assert_eq!(
            phase_b_attempt.trigger_call_attempt_id.as_deref(),
            Some("attempt-c5-phase-a")
        );
        assert_eq!(phase_b_attempt.status, "succeeded");
        assert_eq!(settled.standard_results.len(), 2);
        assert!(settled.context_requests.is_empty());

        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup C5 database");
    }

    #[test]
    fn a6_standard_results_are_atomic_restart_readable_and_independently_terminal() {
        let path = temporary_database_path("a6-standard-result-lifecycle");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-a6-chat",
            "attempt-a6-chat",
            "message-a6-user",
            "2026-08-15T15:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a6-chat",
                "message-a6-assistant",
                "2026-08-15T15:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-a6-parse",
            "message-a6-user",
            "2026-08-15T15:00:02.000Z",
        );
        let prepared = prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        assert!(prepared.provider_invocation_authorized);
        let batch = standard_result_batch("message-a6-user", "2026-08-15T15:00:03.000Z");
        let settled = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-a6-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch.clone()),
                settled_at: "2026-08-15T15:00:03.000Z".into(),
            },
        )
        .unwrap();
        assert_eq!(settled.standard_results.len(), 2);
        assert_eq!(settled.messages.len(), 2);
        assert_eq!(settled.standard_results[0].disposition, "PENDING");
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-a6-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch),
                settled_at: "2026-08-15T15:00:03.000Z".into(),
            },
        )
        .expect("exact terminal replay is idempotent");

        let edited = update_ai_standard_result_draft_in_connection(
            &mut connection,
            &UpdateAIStandardResultDraftInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-create-a6".into(),
                expected_visible_payload_fingerprint: "visible-create-a6-v1".into(),
                visible_payload: serde_json::json!({"title":"Edited visible Task"}),
                visible_payload_fingerprint: "visible-create-a6-v2".into(),
                validation_issues: serde_json::json!([]),
                updated_at: "2026-08-15T15:00:04.000Z".into(),
            },
        )
        .unwrap();
        assert_eq!(edited.standard_results[0].visible_payload["title"], "Edited visible Task");
        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-create-a6".into(),
                parse_call_attempt_id: "attempt-a6-parse".into(),
                expected_visible_payload_fingerprint: "visible-create-a6-v2".into(),
                authorization_id: "authorization-a6-create".into(),
                confirmed_payload: serde_json::json!({"title":"Edited visible Task"}),
                confirmed_payload_fingerprint: "visible-create-a6-v2".into(),
                started_at: "2026-08-15T15:00:05.000Z".into(),
            },
        )
        .unwrap();
        let confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-create-a6".into(),
                authorization_id: "authorization-a6-create".into(),
                effect_receipt: serde_json::json!({
                    "module":"task","entityType":"task","entityId":"task-domain-a6",
                    "operation":"CREATE","service":"planningService.createTask",
                    "canonicalReadback":{"id":"task-domain-a6","projectId":"project-1"}
                }),
                settled_at: "2026-08-15T15:00:06.000Z".into(),
            },
        )
        .unwrap();
        assert_eq!(confirmed.standard_results[0].disposition, "CONFIRMED");
        let dismissed = dismiss_ai_standard_result_in_connection(
            &mut connection,
            &DecideAIStandardResultInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-delete-a6".into(),
                expected_visible_payload_fingerprint: "visible-delete-a6-v1".into(),
                decided_at: "2026-08-15T15:00:07.000Z".into(),
            },
        )
        .unwrap();
        assert_eq!(dismissed.standard_results[1].disposition, "DISMISSED");
        assert!(dismissed.standard_results[1].effect_receipt.is_none());
        drop(connection);

        let reopened = Connection::open(&path).unwrap();
        let readback = read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(readback.standard_results[0].authorization_id.as_deref(), Some("authorization-a6-create"));
        assert_eq!(readback.standard_results[1].disposition, "DISMISSED");
        assert!(standard_result_schema_is_current(&reopened).unwrap());
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp14_a1_b3_route_create_has_exact_durable_target_and_effect_correlation() {
        let path = temporary_database_path("lp14-a1-b3-route-durable-correlation");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-b3-route-chat",
            "attempt-b3-route-chat",
            "message-b3-route-user",
            "2026-08-23T20:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-b3-route-chat",
                "message-b3-route-assistant",
                "2026-08-23T20:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-b3-route-parse",
            "message-b3-route-user",
            "2026-08-23T20:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let mut batch = standard_result_batch(
            "message-b3-route-user",
            "2026-08-23T20:00:03.000Z",
        );
        batch.id = "standard-result-batch-b3-route".into();
        batch.results.truncate(1);
        let result = &mut batch.results[0];
        result.id = "standard-result-b3-route".into();
        result.target = serde_json::json!({
            "module":"route","projectId":"project-1","entityType":"routeNode"
        });
        result.original_payload = serde_json::json!({
            "title":"B3 route","nodeType":"analysis","status":"planned"
        });
        result.visible_payload = result.original_payload.clone();
        result.visible_payload_fingerprint = "visible-b3-route-v1".into();
        let settled = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-b3-route-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch.clone()),
                settled_at: "2026-08-23T20:00:03.000Z".into(),
            },
        )
        .expect("the exact route/routeNode CREATE target must persist");
        assert_eq!(settled.standard_results.len(), 1);
        assert_eq!(settled.standard_results[0].disposition, "PENDING");

        let parse_attempt = settled
            .call_attempts
            .iter()
            .find(|attempt| attempt.id == "attempt-b3-route-parse")
            .expect("B3 Route parse attempt readback");
        let mut forged_update = batch.clone();
        forged_update.results[0].action = "UPDATE".into();
        forged_update.results[0].target["entityId"] = serde_json::json!("route-forged");
        assert!(validate_standard_result_batch(parse_attempt, &forged_update).is_err());
        let mut forged_parent = batch.clone();
        forged_parent.results[0].target["parentNodeId"] = serde_json::json!("route-parent-forged");
        assert!(validate_standard_result_batch(parse_attempt, &forged_parent).is_err());

        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-b3-route".into(),
                parse_call_attempt_id: "attempt-b3-route-parse".into(),
                expected_visible_payload_fingerprint: "visible-b3-route-v1".into(),
                authorization_id: "authorization-b3-route".into(),
                confirmed_payload: batch.results[0].visible_payload.clone(),
                confirmed_payload_fingerprint: "visible-b3-route-v1".into(),
                started_at: "2026-08-23T20:00:04.000Z".into(),
            },
        )
        .expect("the exact pending Route CREATE must be claimable");
        let confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-b3-route".into(),
                authorization_id: "authorization-b3-route".into(),
                effect_receipt: serde_json::json!({
                    "module":"route",
                    "entityType":"routeNode",
                    "entityId":"route-domain-b3",
                    "operation":"CREATE",
                    "service":"planningService.createRouteNode",
                    "canonicalReadback":{
                        "id":"route-domain-b3",
                        "projectId":"project-1",
                        "title":"B3 route",
                        "description":null,
                        "objective":null,
                        "expectedOutput":null,
                        "nodeType":"analysis",
                        "status":"planned",
                        "startDate":null,
                        "endDate":null,
                        "timeLabel":null,
                        "timePrecision":null,
                        "showInGantt":true,
                        "tags":[],
                        "updatedAt":"2026-08-23T20:00:05.000Z"
                    }
                }),
                settled_at: "2026-08-23T20:00:05.000Z".into(),
            },
        )
        .expect("the exact Route receipt must correlate");
        assert_eq!(confirmed.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(
            confirmed.standard_results[0].effect_receipt.as_ref().unwrap()["service"],
            "planningService.createRouteNode"
        );
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp14_a1_f8_route_update_has_exact_durable_target_and_effect_correlation() {
        let path = temporary_database_path("lp14-a1-f8-route-update-durable-correlation");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-f8-route-chat",
            "attempt-f8-route-chat",
            "message-f8-route-user",
            "2026-08-29T22:30:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-f8-route-chat",
                "message-f8-route-assistant",
                "2026-08-29T22:30:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_route_literature_delete_parse_attempt_input(
            "attempt-f8-route-parse",
            "message-f8-route-user",
            "2026-08-29T22:30:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let mut batch = route_literature_delete_standard_result_batch(
            "message-f8-route-user",
            "2026-08-29T22:30:03.000Z",
        );
        batch.id = "standard-result-batch-f8-route-update".into();
        batch.results.truncate(1);
        let result = &mut batch.results[0];
        result.id = "standard-result-f8-route-update".into();
        result.action = "UPDATE".into();
        result.original_payload = serde_json::json!({"description":"F8 Route update"});
        result.visible_payload = result.original_payload.clone();
        result.visible_payload_fingerprint = "visible-f8-route-update-v1".into();
        result.target_snapshot_fingerprint = Some("route-snapshot-f8".into());
        result.validation_issues = serde_json::json!([]);
        let settled = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-f8-route-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch.clone()),
                settled_at: "2026-08-29T22:30:03.000Z".into(),
            },
        )
        .expect("the exact frozen route/routeNode UPDATE target must persist");
        assert_eq!(settled.standard_results.len(), 1);
        assert_eq!(settled.standard_results[0].disposition, "PENDING");

        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-f8-route-update".into(),
                parse_call_attempt_id: "attempt-f8-route-parse".into(),
                expected_visible_payload_fingerprint: "visible-f8-route-update-v1".into(),
                authorization_id: "authorization-f8-route-update".into(),
                confirmed_payload: batch.results[0].visible_payload.clone(),
                confirmed_payload_fingerprint: "visible-f8-route-update-v1".into(),
                started_at: "2026-08-29T22:30:04.000Z".into(),
            },
        )
        .expect("the exact pending Route UPDATE must be claimable");
        let confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-f8-route-update".into(),
                authorization_id: "authorization-f8-route-update".into(),
                effect_receipt: serde_json::json!({
                    "module":"route",
                    "entityType":"routeNode",
                    "entityId":"route-1",
                    "operation":"UPDATE",
                    "service":"planningService.updateRouteNode",
                    "canonicalReadback":{
                        "id":"route-1",
                        "projectId":"project-1",
                        "title":"Existing Route",
                        "description":"F8 Route update",
                        "objective":null,
                        "expectedOutput":null,
                        "nodeType":"analysis",
                        "status":"planned",
                        "startDate":null,
                        "endDate":null,
                        "timeLabel":null,
                        "timePrecision":null,
                        "showInGantt":true,
                        "tags":[],
                        "updatedAt":"2026-08-29T22:30:05.000Z"
                    }
                }),
                settled_at: "2026-08-29T22:30:05.000Z".into(),
            },
        )
        .expect("the exact Route UPDATE receipt must correlate");
        assert_eq!(confirmed.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(
            confirmed.standard_results[0].effect_receipt.as_ref().unwrap()["service"],
            "planningService.updateRouteNode"
        );
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp14_a1_d1_f1_a1_route_delete_validator_is_exact_and_fail_closed() {
        let path = temporary_database_path("lp14-a1-d1-f1-a1-route-delete-validator");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-d1-f1-a1-validator-chat",
            "attempt-d1-f1-a1-validator-chat",
            "message-d1-f1-a1-validator-user",
            "2026-08-27T22:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-d1-f1-a1-validator-chat",
                "message-d1-f1-a1-validator-assistant",
                "2026-08-27T22:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_route_literature_delete_parse_attempt_input(
            "attempt-d1-f1-a1-validator-parse",
            "message-d1-f1-a1-validator-user",
            "2026-08-27T22:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let parse_attempt = read_call_attempt_by_id(
            &connection,
            "attempt-d1-f1-a1-validator-parse",
        )
        .expect("D1-F1-A1 Parse attempt readback");
        let batch = route_literature_delete_standard_result_batch(
            "message-d1-f1-a1-validator-user",
            "2026-08-27T22:00:03.000Z",
        );
        validate_standard_result_batch(&parse_attempt, &batch)
            .expect("exact Route DELETE plus Literature DELETE batch must validate");

        let mut missing_entity_id = batch.clone();
        missing_entity_id.results[0]
            .target
            .as_object_mut()
            .unwrap()
            .remove("entityId");
        assert!(validate_standard_result_batch(&parse_attempt, &missing_entity_id).is_err());

        let mut wrong_entity_id = batch.clone();
        wrong_entity_id.results[0].target["entityId"] = serde_json::json!("route-2");
        assert!(validate_standard_result_batch(&parse_attempt, &wrong_entity_id).is_err());

        let mut wrong_selected_route = batch.clone();
        wrong_selected_route.results[0].source["selectedRouteIds"] =
            serde_json::json!(["route-2"]);
        assert!(validate_standard_result_batch(&parse_attempt, &wrong_selected_route).is_err());

        let mut duplicate_selected_route = batch.clone();
        duplicate_selected_route.results[0].source["selectedRouteIds"] =
            serde_json::json!(["route-1", "route-1"]);
        assert!(validate_standard_result_batch(&parse_attempt, &duplicate_selected_route).is_err());

        let mut wrong_project = batch.clone();
        wrong_project.results[0].target["projectId"] = serde_json::json!("project-2");
        assert!(validate_standard_result_batch(&parse_attempt, &wrong_project).is_err());

        let mut stale_attempt = parse_attempt.clone();
        stale_attempt
            .context_source_refs
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|source_ref| {
                source_ref.get("module").and_then(Value::as_str) == Some("route")
                    && source_ref.get("contextRole").and_then(Value::as_str) == Some("primary")
            })
            .unwrap()["isVerified"] = serde_json::json!(false);
        assert!(validate_standard_result_batch(&stale_attempt, &batch).is_err());

        let mut wrong_project_scope_attempt = parse_attempt.clone();
        wrong_project_scope_attempt
            .context_source_refs
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|source_ref| {
                source_ref.get("module").and_then(Value::as_str) == Some("project")
                    && source_ref.get("contextRole").and_then(Value::as_str) == Some("scope")
            })
            .unwrap()["entityId"] = serde_json::json!("project-2");
        assert!(validate_standard_result_batch(&wrong_project_scope_attempt, &batch).is_err());

        let mut wrong_discussion_scope_attempt = parse_attempt.clone();
        wrong_discussion_scope_attempt
            .context_source_refs
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|source_ref| {
                source_ref.get("field").and_then(Value::as_str)
                    == Some("relevantEffectiveDiscussion")
            })
            .unwrap()["parseRouteIds"] = serde_json::json!(["route-2"]);
        assert!(validate_standard_result_batch(&wrong_discussion_scope_attempt, &batch).is_err());

        let mut wrong_shape = batch.clone();
        wrong_shape.results[0].target["expectedUpdatedAt"] =
            serde_json::json!("2026-08-27T21:59:59.000Z");
        assert!(validate_standard_result_batch(&parse_attempt, &wrong_shape).is_err());

        let mut forbidden_update = batch.clone();
        forbidden_update.results[0].action = "UPDATE".into();
        assert!(validate_standard_result_batch(&parse_attempt, &forbidden_update).is_err());

        let mut exact_route_create = standard_result_batch(
            "message-d1-f1-a1-validator-user",
            "2026-08-27T22:00:03.000Z",
        );
        exact_route_create.results.truncate(1);
        exact_route_create.results[0].target = serde_json::json!({
            "module":"route","projectId":"project-1","entityType":"routeNode"
        });
        exact_route_create.results[0].source["selectedRouteIds"] = serde_json::json!([]);
        validate_standard_result_batch(&parse_attempt, &exact_route_create)
            .expect("exact three-key Route CREATE must remain valid");

        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp14_a1_d1_f1_a1_route_and_literature_delete_persist_two_to_two_advisory_only() {
        let path = temporary_database_path("lp14-a1-d1-f1-a1-route-literature-delete-2-to-2");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-d1-f1-a1-persist-chat",
            "attempt-d1-f1-a1-persist-chat",
            "message-d1-f1-a1-persist-user",
            "2026-08-27T22:01:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-d1-f1-a1-persist-chat",
                "message-d1-f1-a1-persist-assistant",
                "2026-08-27T22:01:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_route_literature_delete_parse_attempt_input(
            "attempt-d1-f1-a1-persist-parse",
            "message-d1-f1-a1-persist-user",
            "2026-08-27T22:01:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let batch = route_literature_delete_standard_result_batch(
            "message-d1-f1-a1-persist-user",
            "2026-08-27T22:01:03.000Z",
        );
        let settled = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-d1-f1-a1-persist-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch.clone()),
                settled_at: "2026-08-27T22:01:03.000Z".into(),
            },
        )
        .expect("exact Route and Literature DELETE advisory batch must persist atomically");
        assert_eq!(settled.standard_results.len(), 2);
        assert_eq!(settled.standard_results[0].id, "standard-result-route-delete-d1-f1-a1");
        assert_eq!(settled.standard_results[0].ordinal, 1);
        assert_eq!(settled.standard_results[0].action, "DELETE_SUGGESTION");
        assert_eq!(settled.standard_results[0].target["module"], "route");
        assert_eq!(settled.standard_results[0].target["entityType"], "routeNode");
        assert_eq!(settled.standard_results[0].target["entityId"], "route-1");
        assert_eq!(settled.standard_results[1].id, "standard-result-literature-delete-d1-f1-a1");
        assert_eq!(settled.standard_results[1].ordinal, 2);
        assert_eq!(settled.standard_results[1].action, "DELETE_SUGGESTION");
        assert_eq!(settled.standard_results[1].target["module"], "literature");
        assert_eq!(settled.standard_results[1].target["entityId"], "literature-1");
        assert!(settled.standard_results.iter().all(|result| {
            result.disposition == "PENDING"
                && result.authorization_id.is_none()
                && result.confirmation_started_at.is_none()
                && result.effect_receipt.is_none()
                && result.validation_issues.as_array().is_some_and(|issues| {
                    issues.iter().any(|issue| {
                        issue.get("code").and_then(Value::as_str)
                            == Some("DELETE_SUGGESTION_INFORMATIONAL_ONLY")
                    })
                })
        }));

        for (result_id, fingerprint, authorization_id) in [
            (
                "standard-result-route-delete-d1-f1-a1",
                "visible-route-delete-d1-f1-a1-v1",
                "authorization-route-delete-d1-f1-a1",
            ),
            (
                "standard-result-literature-delete-d1-f1-a1",
                "visible-literature-delete-d1-f1-a1-v1",
                "authorization-literature-delete-d1-f1-a1",
            ),
        ] {
            let result = settled
                .standard_results
                .iter()
                .find(|candidate| candidate.id == result_id)
                .unwrap();
            let error = begin_ai_standard_result_confirmation_in_connection(
                &mut connection,
                &BeginAIStandardResultConfirmationInput {
                    conversation_id: CURRENT_CONVERSATION_ID.into(),
                    result_id: result_id.into(),
                    parse_call_attempt_id: "attempt-d1-f1-a1-persist-parse".into(),
                    expected_visible_payload_fingerprint: fingerprint.into(),
                    authorization_id: authorization_id.into(),
                    confirmed_payload: result.visible_payload.clone(),
                    confirmed_payload_fingerprint: fingerprint.into(),
                    started_at: "2026-08-27T22:01:04.000Z".into(),
                },
            )
            .expect_err("DELETE advisory must not expose executable confirmation");
            assert!(error.contains("AI_STANDARD_RESULT_CONFIRMATION_CONFLICT"));
        }

        let unchanged = read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID)
            .expect("D1-F1-A1 post-confirmation-attempt readback");
        assert!(unchanged.standard_results.iter().all(|result| {
            result.disposition == "PENDING"
                && result.authorization_id.is_none()
                && result.confirmation_started_at.is_none()
                && result.effect_receipt.is_none()
        }));
        drop(connection);

        let reopened = Connection::open(&path).unwrap();
        let readback = read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID)
            .expect("D1-F1-A1 restart readback");
        assert_eq!(readback.standard_results.len(), 2);
        assert_eq!(readback.standard_results[0].ordinal, 1);
        assert_eq!(readback.standard_results[1].ordinal, 2);
        assert!(readback.standard_results.iter().all(|result| {
            result.disposition == "PENDING"
                && result.authorization_id.is_none()
                && result.effect_receipt.is_none()
        }));
        assert!(standard_result_schema_is_current(&reopened).unwrap());
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b8_literature_create_accepts_project_scope_without_existing_literature() {
        let path = temporary_database_path("b8-literature-project-scope-create");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-b8-literature-chat",
            "attempt-b8-literature-chat",
            "message-b8-literature-user",
            "2026-08-24T21:05:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-b8-literature-chat",
                "message-b8-literature-assistant",
                "2026-08-24T21:05:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-b8-literature-parse",
            "message-b8-literature-user",
            "2026-08-24T21:05:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let mut batch = a16_literature_standard_result_batch(
            "message-b8-literature-user",
            "2026-08-24T21:05:03.000Z",
        );
        batch.id = "standard-result-batch-b8-literature-create".into();
        batch.results.truncate(1);
        batch.results[0].id = "standard-result-b8-literature-create".into();
        batch.results[0].source["selectedLiteratureIds"] = serde_json::json!([]);
        batch.results[0].source["literatureAssociationTuples"] = serde_json::json!([]);

        let settled = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-b8-literature-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch),
                settled_at: "2026-08-24T21:05:03.000Z".into(),
            },
        )
        .expect("project-scoped Literature CREATE must settle without a pre-existing Literature");
        assert_eq!(settled.standard_results.len(), 1);
        assert_eq!(settled.standard_results[0].target["primaryProjectId"], Value::Null);
        assert_eq!(
            settled.standard_results[0].source["selectedLiteratureIds"],
            serde_json::json!([])
        );
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup B8 Literature database");
    }

    #[test]
    fn b8_outputs_five_layer_create_requires_exact_durable_receipts() {
        for (module, service) in [
            ("resultItem", "outputConversionService.createResultItem"),
            ("finding", "outputConversionService.createFinding"),
            ("outputCandidate", "outputConversionService.createOutputCandidate"),
            ("outputGap", "outputConversionService.createOutputGapForDeposition"),
            ("researchOutput", "outputService.create"),
        ] {
            let path = temporary_database_path(&format!("b8-output-{module}-create"));
            let mut connection = open_current_database(&path);
            let chat_attempt_id = format!("attempt-b8-{module}-chat");
            let parse_attempt_id = format!("attempt-b8-{module}-parse");
            let user_message_id = format!("message-b8-{module}-user");
            let assistant_message_id = format!("message-b8-{module}-assistant");
            let result_id = format!("standard-result-b8-{module}-create");
            let authorization_id = format!("authorization-b8-{module}-create");
            let fingerprint = format!("visible-b8-{module}-create-v1");
            let entity_id = format!("{module}-created-b8");
            let chat = prepare_input(
                &chat_attempt_id,
                &chat_attempt_id,
                &user_message_id,
                "2026-08-24T21:06:00.000Z",
            );
            prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
            settle_ai_call_attempt_success_in_connection(
                &mut connection,
                &settle_success_input(
                    &chat_attempt_id,
                    &assistant_message_id,
                    "2026-08-24T21:06:01.000Z",
                ),
            )
            .unwrap();
            let parse = prepare_parse_attempt_input(
                &parse_attempt_id,
                &user_message_id,
                "2026-08-24T21:06:02.000Z",
            );
            prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
            let mut batch = a16_finding_standard_result_batch(
                &user_message_id,
                "2026-08-24T21:06:03.000Z",
            );
            batch.id = format!("standard-result-batch-b8-{module}-create");
            batch.results[0].id = result_id.clone();
            batch.results[0].target = serde_json::json!({
                "module":module,"projectId":"project-1","entityType":module
            });
            batch.results[0].original_payload = serde_json::json!({
                "title":format!("B8 {module} exact create")
            });
            batch.results[0].visible_payload = batch.results[0].original_payload.clone();
            batch.results[0].visible_payload_fingerprint = fingerprint.clone();
            settle_ai_call_attempt_success_in_connection(
                &mut connection,
                &SettleAICallAttemptSuccessInput {
                    attempt_id: parse_attempt_id.clone(),
                    provider: "deepseek".into(),
                    model: "deepseek-v4-flash".into(),
                    response_truncated: Some(false),
                    usage: None,
                    assistant_message: None,
                    context_request: None,
                    standard_result_batch: Some(batch.clone()),
                    settled_at: "2026-08-24T21:06:03.000Z".into(),
                },
            )
            .expect("all five Outputs CREATE targets must settle durably");
            begin_ai_standard_result_confirmation_in_connection(
                &mut connection,
                &BeginAIStandardResultConfirmationInput {
                    conversation_id: CURRENT_CONVERSATION_ID.into(),
                    result_id: result_id.clone(),
                    parse_call_attempt_id: parse_attempt_id,
                    expected_visible_payload_fingerprint: fingerprint.clone(),
                    authorization_id: authorization_id.clone(),
                    confirmed_payload: batch.results[0].visible_payload.clone(),
                    confirmed_payload_fingerprint: fingerprint.clone(),
                    started_at: "2026-08-24T21:06:04.000Z".into(),
                },
            )
            .expect("all five Outputs CREATE Results must be claimable");
            let confirmed = settle_ai_standard_result_effect_in_connection(
                &mut connection,
                &SettleAIStandardResultEffectInput {
                    conversation_id: CURRENT_CONVERSATION_ID.into(),
                    result_id: result_id.clone(),
                    authorization_id: authorization_id.clone(),
                    effect_receipt: serde_json::json!({
                        "module":module,"entityType":module,"entityId":entity_id,
                        "operation":"CREATE","service":service,
                        "canonicalReadback":{
                            "id":entity_id,"projectId":"project-1",
                            "title":format!("B8 {module} exact create"),"brief":"",
                            "structuredSummary":[],"updatedAt":"2026-08-24T21:06:05.000Z",
                            "resultId":result_id,"authorizationId":authorization_id,
                            "confirmedPayloadFingerprint":fingerprint
                        }
                    }),
                    settled_at: "2026-08-24T21:06:05.000Z".into(),
                },
            )
            .expect("all five Outputs CREATE receipts must correlate exactly");
            assert_eq!(confirmed.standard_results[0].disposition, "CONFIRMED", "{module}");
            drop(connection);
            std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup B8 Outputs database");
        }
    }

    #[test]
    fn b10_result_item_update_requires_exact_operation_module_and_project_source() {
        let path = temporary_database_path("b10-result-item-update-provenance");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-b10-result-item-chat",
            "attempt-b10-result-item-chat",
            "message-b10-result-item-user",
            "2026-08-25T06:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-b10-result-item-chat",
                "message-b10-result-item-assistant",
                "2026-08-25T06:00:01.000Z",
            ),
        )
        .unwrap();
        let mut parse = prepare_parse_attempt_input(
            "attempt-b10-result-item-parse",
            "message-b10-result-item-user",
            "2026-08-25T06:00:02.000Z",
        );
        parse
            .context_source_refs
            .as_array_mut()
            .expect("B10 Parse ContextRefs")
            .push(serde_json::json!({
                "module":"outputConversion",
                "entityType":"resultItem",
                "entityId":"result-item-b10",
                "contextDisposition":"included",
                "contextRole":"primary",
                "isVerified":true
            }));
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let parse_attempt = read_call_attempt_by_id(
            &connection,
            "attempt-b10-result-item-parse",
        )
        .expect("B10 ResultItem parse attempt readback");

        let mut batch = a16_finding_standard_result_batch(
            "message-b10-result-item-user",
            "2026-08-25T06:00:03.000Z",
        );
        batch.id = "standard-result-batch-b10-result-item-update".into();
        let result = &mut batch.results[0];
        result.id = "standard-result-b10-result-item-update".into();
        result.action = "UPDATE".into();
        result.target = serde_json::json!({
            "module":"resultItem",
            "projectId":"project-1",
            "entityType":"resultItem",
            "entityId":"result-item-b10"
        });
        result.original_payload = serde_json::json!({
            "summary":"B10 exact ResultItem update"
        });
        result.visible_payload = result.original_payload.clone();
        result.visible_payload_fingerprint = "visible-b10-result-item-update-v1".into();
        result.target_snapshot_fingerprint = Some("snapshot-b10-result-item-v1".into());

        validate_standard_result_batch(&parse_attempt, &batch)
            .expect("the exact ResultItem UPDATE operation tuple and source Project must be admitted");

        let mut aggregate_module = batch.clone();
        aggregate_module.results[0].target["module"] = serde_json::json!("outputConversion");
        assert!(validate_standard_result_batch(&parse_attempt, &aggregate_module).is_err());

        let mut wrong_target_project = batch.clone();
        wrong_target_project.results[0].target["projectId"] = serde_json::json!("project-2");
        assert!(validate_standard_result_batch(&parse_attempt, &wrong_target_project).is_err());

        let mut wrong_source_project = batch.clone();
        wrong_source_project.results[0].source["projectId"] = serde_json::json!("project-2");
        assert!(validate_standard_result_batch(&parse_attempt, &wrong_source_project).is_err());

        let mut wrong_frozen_target = batch.clone();
        wrong_frozen_target.results[0].target["entityId"] = serde_json::json!("result-item-other");
        assert!(validate_standard_result_batch(&parse_attempt, &wrong_frozen_target).is_err());

        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup B10 ResultItem database");
    }

    #[test]
    fn a16_finding_create_requires_exact_durable_target_and_effect_correlation() {
        let path = temporary_database_path("a16-finding-durable-correlation");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-a16-finding-chat",
            "attempt-a16-finding-chat",
            "message-a16-finding-user",
            "2026-08-20T08:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a16-finding-chat",
                "message-a16-finding-assistant",
                "2026-08-20T08:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-a16-finding-parse",
            "message-a16-finding-user",
            "2026-08-20T08:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let batch = a16_finding_standard_result_batch(
            "message-a16-finding-user",
            "2026-08-20T08:00:03.000Z",
        );
        let settled = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-a16-finding-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch.clone()),
                settled_at: "2026-08-20T08:00:03.000Z".into(),
            },
        )
        .expect("the exact finding/finding CREATE target must persist");
        assert_eq!(settled.standard_results.len(), 1);
        assert_eq!(settled.standard_results[0].disposition, "PENDING");

        let parse_attempt = settled
            .call_attempts
            .iter()
            .find(|attempt| attempt.id == "attempt-a16-finding-parse")
            .expect("parse attempt readback");
        let mut wrong_module = batch.clone();
        wrong_module.results[0].target["module"] = serde_json::json!("output");
        assert!(validate_standard_result_batch(parse_attempt, &wrong_module).is_err());
        let mut wrong_entity = batch.clone();
        wrong_entity.results[0].target["entityType"] = serde_json::json!("outputCandidate");
        assert!(validate_standard_result_batch(parse_attempt, &wrong_entity).is_err());
        let mut wrong_action = batch.clone();
        wrong_action.results[0].action = "UPDATE".into();
        assert!(validate_standard_result_batch(parse_attempt, &wrong_action).is_err());
        let mut extra_target_authority = batch.clone();
        extra_target_authority.results[0].target["ownerId"] = serde_json::json!("forged");
        assert!(validate_standard_result_batch(parse_attempt, &extra_target_authority).is_err());

        let result_id = "standard-result-finding-a16";
        let authorization_id = "authorization-finding-a16";
        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: result_id.into(),
                parse_call_attempt_id: "attempt-a16-finding-parse".into(),
                expected_visible_payload_fingerprint: "visible-finding-a16-v1".into(),
                authorization_id: authorization_id.into(),
                confirmed_payload: batch.results[0].visible_payload.clone(),
                confirmed_payload_fingerprint: "visible-finding-a16-v1".into(),
                started_at: "2026-08-20T08:00:04.000Z".into(),
            },
        )
        .expect("the exact durable Finding must be claimable");
        let valid_receipt = serde_json::json!({
            "module":"finding","entityType":"finding","entityId":"finding-created-a16",
            "operation":"CREATE","service":"outputConversionService.createFinding",
            "canonicalReadback":{
                "id":"finding-created-a16","projectId":"project-1",
                "title":"A16 exact Finding","brief":"Bounded durable parity fixture",
                "structuredSummary":[],"updatedAt":"2026-08-20T08:00:05.000Z",
                "resultId":result_id,"authorizationId":authorization_id,
                "confirmedPayloadFingerprint":"visible-finding-a16-v1"
            }
        });
        let settle = |effect_receipt: Value| SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: result_id.into(),
            authorization_id: authorization_id.into(),
            effect_receipt,
            settled_at: "2026-08-20T08:00:05.000Z".into(),
        };
        for (pointer, forged_value) in [
            ("/service", serde_json::json!("outputConversionService.createCandidate")),
            ("/canonicalReadback/projectId", serde_json::json!("project-2")),
            ("/canonicalReadback/resultId", serde_json::json!("standard-result-forged")),
            ("/canonicalReadback/authorizationId", serde_json::json!("authorization-forged")),
        ] {
            let mut forged = valid_receipt.clone();
            *forged.pointer_mut(pointer).expect("forged receipt pointer") = forged_value;
            assert!(settle_ai_standard_result_effect_in_connection(
                &mut connection,
                &settle(forged),
            )
            .is_err());
        }
        let confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &settle(valid_receipt),
        )
        .expect("the exact correlated Finding receipt must settle");
        assert_eq!(confirmed.standard_results.len(), 1);
        assert_eq!(confirmed.standard_results[0].disposition, "CONFIRMED");
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent Finding reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.standard_results.len(), 1);
        assert_eq!(readback.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(
            readback.standard_results[0].effect_receipt.as_ref().unwrap()
                ["canonicalReadback"]["resultId"],
            result_id
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn a7_review_create_update_and_new_manuscript_effects_require_exact_durable_correlation() {
        let path = temporary_database_path("a7-review-standard-result-correlation");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-a7-chat",
            "attempt-a7-chat",
            "message-a7-user",
            "2026-08-15T17:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a7-chat",
                "message-a7-assistant",
                "2026-08-15T17:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-a7-parse",
            "message-a7-user",
            "2026-08-15T17:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let batch = a7_review_standard_result_batch(
            "message-a7-user",
            "2026-08-15T17:00:03.000Z",
        );
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-a7-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch),
                settled_at: "2026-08-15T17:00:03.000Z".into(),
            },
        )
        .unwrap();

        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-review-create-a7".into(),
                parse_call_attempt_id: "attempt-a7-parse".into(),
                expected_visible_payload_fingerprint: "visible-review-create-a7-v1".into(),
                authorization_id: "authorization-review-create-a7".into(),
                confirmed_payload: serde_json::json!({
                    "title":"Review created from discussion",
                    "reviewType":"stage",
                    "periodStart":"2026-08-01",
                    "periodEnd":"2026-08-15",
                    "summary":"Evidence-backed summary"
                }),
                confirmed_payload_fingerprint: "visible-review-create-a7-v1".into(),
                started_at: "2026-08-15T17:00:04.000Z".into(),
            },
        )
        .unwrap();
        settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-review-create-a7".into(),
                authorization_id: "authorization-review-create-a7".into(),
                effect_receipt: serde_json::json!({
                    "module":"review","entityType":"review","entityId":"review-created-a7",
                    "operation":"CREATE","service":"planningService.createReviewWithTargets",
                    "canonicalReadback":{
                        "id":"review-created-a7","projectId":"project-1",
                        "aiStandardResultId":"standard-result-review-create-a7"
                    }
                }),
                settled_at: "2026-08-15T17:00:05.000Z".into(),
            },
        )
        .unwrap();

        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-review-manuscript-a7".into(),
                parse_call_attempt_id: "attempt-a7-parse".into(),
                expected_visible_payload_fingerprint: "visible-review-manuscript-a7-v1".into(),
                authorization_id: "authorization-review-manuscript-a7".into(),
                confirmed_payload: serde_json::json!({"body":"# Candidate\n\nBody"}),
                confirmed_payload_fingerprint: "visible-review-manuscript-a7-v1".into(),
                started_at: "2026-08-15T17:00:06.000Z".into(),
            },
        )
        .unwrap();
        let forged_receipt = SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: "standard-result-review-manuscript-a7".into(),
            authorization_id: "authorization-review-manuscript-a7".into(),
            effect_receipt: serde_json::json!({
                "module":"review","entityType":"fileRef","entityId":"file-ref-a7",
                "operation":"NEW_MANUSCRIPT","service":"reviewCandidateService.saveCandidate",
                "canonicalReadback":{
                    "projectId":"project-1","reviewId":"review-1","fileRefId":"file-ref-a7",
                    "manuscriptChannel":"primary","operationId":"forged-operation",
                    "candidateRequestId":"standard-result-review-manuscript-a7"
                }
            }),
            settled_at: "2026-08-15T17:00:07.000Z".into(),
        };
        assert!(settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &forged_receipt,
        )
        .is_err());
        let manuscript_confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                effect_receipt: serde_json::json!({
                    "module":"review","entityType":"fileRef","entityId":"file-ref-a7",
                    "operation":"NEW_MANUSCRIPT","service":"reviewCandidateService.saveCandidate",
                    "canonicalReadback":{
                        "projectId":"project-1","reviewId":"review-1","fileRefId":"file-ref-a7",
                        "manuscriptChannel":"primary",
                        "operationId":"standard-result-review-manuscript-a7",
                        "candidateRequestId":"standard-result-review-manuscript-a7"
                    }
                }),
                ..forged_receipt
            },
        )
        .unwrap();
        assert_eq!(manuscript_confirmed.standard_results[1].disposition, "CONFIRMED");

        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "standard-result-review-update-a7".into(),
                parse_call_attempt_id: "attempt-a7-parse".into(),
                expected_visible_payload_fingerprint: "visible-review-update-a7-v1".into(),
                authorization_id: "authorization-review-update-a7".into(),
                confirmed_payload: serde_json::json!({
                    "outlineSections":[{"key":"stage_summary","content":"2"}]
                }),
                confirmed_payload_fingerprint: "visible-review-update-a7-v1".into(),
                started_at: "2026-08-15T17:00:08.000Z".into(),
            },
        )
        .unwrap();
        let forged_update_receipt = SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: "standard-result-review-update-a7".into(),
            authorization_id: "authorization-review-update-a7".into(),
            effect_receipt: serde_json::json!({
                "module":"review","entityType":"review","entityId":"review-forged-a7",
                "operation":"UPDATE","service":"planningService.updateReview",
                "canonicalReadback":{
                    "id":"review-forged-a7","projectId":"project-1",
                    "resultCorrelationId":"standard-result-review-update-a7"
                }
            }),
            settled_at: "2026-08-15T17:00:09.000Z".into(),
        };
        assert!(settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &forged_update_receipt,
        )
        .is_err());
        let update_confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                effect_receipt: serde_json::json!({
                    "module":"review","entityType":"review","entityId":"review-1",
                    "operation":"UPDATE","service":"planningService.updateReview",
                    "canonicalReadback":{
                        "id":"review-1","projectId":"project-1",
                        "resultCorrelationId":"standard-result-review-update-a7"
                    }
                }),
                settled_at: "2026-08-15T17:00:10.000Z".into(),
                ..forged_update_receipt
            },
        )
        .unwrap();
        assert_eq!(update_confirmed.standard_results[2].disposition, "CONFIRMED");
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(readback.standard_results[1].disposition, "CONFIRMED");
        assert_eq!(readback.standard_results[2].disposition, "CONFIRMED");
        assert_eq!(
            readback.standard_results[1].effect_receipt.as_ref().unwrap()
                ["canonicalReadback"]["operationId"],
            "standard-result-review-manuscript-a7"
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn a10_experiment_create_update_require_exact_tuples_and_durable_operation_correlation() {
        let path = temporary_database_path("a10-experiment-standard-result-correlation");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-a10-chat",
            "attempt-a10-chat",
            "message-a10-user",
            "2026-08-15T18:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a10-chat",
                "message-a10-assistant",
                "2026-08-15T18:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-a10-parse",
            "message-a10-user",
            "2026-08-15T18:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-a10-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(a10_experiment_standard_result_batch(
                    "message-a10-user",
                    "2026-08-15T18:00:03.000Z",
                )),
                settled_at: "2026-08-15T18:00:03.000Z".into(),
            },
        )
        .unwrap();

        let begin = |result_id: &str,
                     fingerprint: &str,
                     authorization_id: &str,
                     payload: Value,
                     started_at: &str| BeginAIStandardResultConfirmationInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: result_id.into(),
            parse_call_attempt_id: "attempt-a10-parse".into(),
            expected_visible_payload_fingerprint: fingerprint.into(),
            authorization_id: authorization_id.into(),
            confirmed_payload: payload,
            confirmed_payload_fingerprint: fingerprint.into(),
            started_at: started_at.into(),
        };

        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &begin(
                "standard-result-experiment-create-a10",
                "visible-experiment-create-a10-v1",
                "authorization-experiment-create-a10",
                serde_json::json!({"title":"Create Experiment","status":"planned"}),
                "2026-08-15T18:00:04.000Z",
            ),
        )
        .unwrap();
        let forged_create = SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: "standard-result-experiment-create-a10".into(),
            authorization_id: "authorization-experiment-create-a10".into(),
            effect_receipt: serde_json::json!({
                "module":"experiment","entityType":"experiment","entityId":"experiment-created-a10",
                "operation":"CREATE","service":"arbitraryService.write",
                "canonicalReadback":{
                    "id":"experiment-created-a10","projectId":"project-1",
                    "operationId":"standard-result-experiment-create-a10",
                    "authorizationId":"authorization-experiment-create-a10",
                    "confirmedPayloadFingerprint":"visible-experiment-create-a10-v1"
                }
            }),
            settled_at: "2026-08-15T18:00:05.000Z".into(),
        };
        assert!(settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &forged_create,
        )
        .is_err());
        let create_confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                effect_receipt: serde_json::json!({
                    "module":"experiment","entityType":"experiment","entityId":"experiment-created-a10",
                    "operation":"CREATE","service":"experimentService.createExperiment",
                    "canonicalReadback":{
                        "id":"experiment-created-a10","projectId":"project-1",
                        "operationId":"standard-result-experiment-create-a10",
                        "authorizationId":"authorization-experiment-create-a10",
                        "confirmedPayloadFingerprint":"visible-experiment-create-a10-v1"
                    }
                }),
                ..forged_create
            },
        )
        .unwrap();
        assert_eq!(create_confirmed.standard_results[0].disposition, "CONFIRMED");

        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &begin(
                "standard-result-experiment-update-a10",
                "visible-experiment-update-a10-v1",
                "authorization-experiment-update-a10",
                serde_json::json!({"title":"Update Experiment"}),
                "2026-08-15T18:00:06.000Z",
            ),
        )
        .unwrap();
        let forged_update = SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: "standard-result-experiment-update-a10".into(),
            authorization_id: "authorization-experiment-update-a10".into(),
            effect_receipt: serde_json::json!({
                "module":"experiment","entityType":"experiment","entityId":"experiment-forged",
                "operation":"UPDATE","service":"experimentService.updateExperiment",
                "canonicalReadback":{
                    "id":"experiment-forged","projectId":"project-1",
                    "operationId":"standard-result-experiment-update-a10",
                    "authorizationId":"authorization-experiment-update-a10",
                    "confirmedPayloadFingerprint":"visible-experiment-update-a10-v1"
                }
            }),
            settled_at: "2026-08-15T18:00:07.000Z".into(),
        };
        assert!(settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &forged_update,
        )
        .is_err());
        let update_confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                effect_receipt: serde_json::json!({
                    "module":"experiment","entityType":"experiment","entityId":"experiment-1",
                    "operation":"UPDATE","service":"experimentService.updateExperiment",
                    "canonicalReadback":{
                        "id":"experiment-1","projectId":"project-1",
                        "operationId":"standard-result-experiment-update-a10",
                        "authorizationId":"authorization-experiment-update-a10",
                        "confirmedPayloadFingerprint":"visible-experiment-update-a10-v1"
                    }
                }),
                ..forged_update
            },
        )
        .unwrap();
        assert_eq!(update_confirmed.standard_results[1].disposition, "CONFIRMED");

        // DELETE_SUGGESTION remains informational-only. Experiment/primary
        // NEW_MANUSCRIPT is exercised by the successor A11 durable test below.
        for (result_id, fingerprint, authorization, payload) in [(
            "standard-result-experiment-delete-a10",
            "visible-experiment-delete-a10-v1",
            "authorization-experiment-delete-a10",
            serde_json::json!({"reason":"Review manually"}),
        )] {
            assert!(begin_ai_standard_result_confirmation_in_connection(
                &mut connection,
                &begin(
                    result_id,
                    fingerprint,
                    authorization,
                    payload,
                    "2026-08-15T18:00:08.000Z",
                ),
            )
            .is_err());
        }

        drop(connection);
        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(readback.standard_results[1].disposition, "CONFIRMED");
        assert_eq!(readback.standard_results[2].disposition, "PENDING");
        assert_eq!(readback.standard_results[3].disposition, "PENDING");
        assert_eq!(
            readback.standard_results[1].effect_receipt.as_ref().unwrap()
                ["canonicalReadback"]["operationId"],
            "standard-result-experiment-update-a10"
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn b8_experiment_run_create_accepts_one_direct_parent_without_existing_run_scope() {
        for (
            case,
            target_parent_id,
            selected_experiment_ids,
            selected_run_ids,
            parent_relations,
            should_succeed,
        ) in [
            (
                "direct-parent",
                "experiment-1",
                serde_json::json!(["experiment-1"]),
                serde_json::json!([]),
                serde_json::json!([]),
                true,
            ),
            (
                "mismatched-parent",
                "experiment-forged",
                serde_json::json!(["experiment-1"]),
                serde_json::json!([]),
                serde_json::json!([]),
                false,
            ),
            (
                "direct-parent-precedes-unrelated-run-parent",
                "experiment-1",
                serde_json::json!(["experiment-1"]),
                serde_json::json!(["run-1"]),
                serde_json::json!([{
                    "runId": "run-1",
                    "parentExperimentId": "experiment-2",
                    "projectId": "project-1",
                    "selectionOrder": 0
                }]),
                true,
            ),
            (
                "two-direct-parents-remain-ambiguous",
                "experiment-1",
                serde_json::json!(["experiment-1", "experiment-2"]),
                serde_json::json!([]),
                serde_json::json!([]),
                false,
            ),
        ] {
            let path = temporary_database_path(&format!("b8-run-create-{case}"));
            let mut connection = open_current_database(&path);
            let chat = prepare_input(
                "attempt-b8-run-chat",
                "attempt-b8-run-chat",
                "message-b8-run-user",
                "2026-08-24T20:55:00.000Z",
            );
            prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
            settle_ai_call_attempt_success_in_connection(
                &mut connection,
                &settle_success_input(
                    "attempt-b8-run-chat",
                    "message-b8-run-assistant",
                    "2026-08-24T20:55:01.000Z",
                ),
            )
            .unwrap();
            let parse = prepare_parse_attempt_input(
                "attempt-b8-run-parse",
                "message-b8-run-user",
                "2026-08-24T20:55:02.000Z",
            );
            prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
            let mut batch = a13_experiment_run_standard_result_batch(
                "message-b8-run-user",
                "2026-08-24T20:55:03.000Z",
            );
            batch.id = format!("standard-result-batch-b8-{case}");
            batch.results.truncate(1);
            batch.results[0].id = format!("standard-result-run-create-b8-{case}");
            batch.results[0].target["parentExperimentId"] =
                serde_json::json!(target_parent_id);
            batch.results[0].source["selectedExperimentIds"] = selected_experiment_ids;
            batch.results[0].source["selectedExperimentRunIds"] = selected_run_ids;
            batch.results[0].source["experimentRunParentRelations"] = parent_relations;

            let settled = settle_ai_call_attempt_success_in_connection(
                &mut connection,
                &SettleAICallAttemptSuccessInput {
                    attempt_id: "attempt-b8-run-parse".into(),
                    provider: "deepseek".into(),
                    model: "deepseek-v4-flash".into(),
                    response_truncated: Some(false),
                    usage: None,
                    assistant_message: None,
                    context_request: None,
                    standard_result_batch: Some(batch),
                    settled_at: "2026-08-24T20:55:03.000Z".into(),
                },
            );
            assert_eq!(settled.is_ok(), should_succeed, "{case}");
            if let Ok(readback) = settled {
                assert_eq!(readback.standard_results.len(), 1);
                assert_eq!(
                    readback.standard_results[0].target["parentExperimentId"],
                    "experiment-1"
                );
                assert_eq!(
                    readback.standard_results[0].source["selectedExperimentRunIds"],
                    if case == "direct-parent-precedes-unrelated-run-parent" {
                        serde_json::json!(["run-1"])
                    } else {
                        serde_json::json!([])
                    }
                );
            }
            drop(connection);
            std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup B8 run database");
        }
    }

    #[test]
    fn a13_experiment_run_create_update_require_exact_durable_tuples_and_reopen_correlation() {
        let path = temporary_database_path("a13-experiment-run-standard-result-correlation");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-a13-chat",
            "attempt-a13-chat",
            "message-a13-user",
            "2026-08-16T19:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a13-chat",
                "message-a13-assistant",
                "2026-08-16T19:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-a13-parse",
            "message-a13-user",
            "2026-08-16T19:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-a13-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(a13_experiment_run_standard_result_batch(
                    "message-a13-user",
                    "2026-08-16T19:00:03.000Z",
                )),
                settled_at: "2026-08-16T19:00:03.000Z".into(),
            },
        )
        .unwrap();

        let begin = |result_id: &str,
                     fingerprint: &str,
                     authorization_id: &str,
                     payload: Value,
                     started_at: &str| BeginAIStandardResultConfirmationInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: result_id.into(),
            parse_call_attempt_id: "attempt-a13-parse".into(),
            expected_visible_payload_fingerprint: fingerprint.into(),
            authorization_id: authorization_id.into(),
            confirmed_payload: payload,
            confirmed_payload_fingerprint: fingerprint.into(),
            started_at: started_at.into(),
        };

        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &begin(
                "standard-result-run-create-a13",
                "visible-run-create-a13-v1",
                "authorization-run-create-a13",
                serde_json::json!({"title":"Create Run","status":"planned"}),
                "2026-08-16T19:00:04.000Z",
            ),
        )
        .unwrap();
        let forged_create = SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: "standard-result-run-create-a13".into(),
            authorization_id: "authorization-run-create-a13".into(),
            effect_receipt: serde_json::json!({
                "module":"experimentRun","entityType":"experimentRun","entityId":"run-created-a13",
                "operation":"CREATE","service":"arbitraryService.write",
                "canonicalReadback":{
                    "id":"run-created-a13","experimentId":"experiment-1","projectId":"project-1",
                    "operationId":"standard-result-run-create-a13",
                    "authorizationId":"authorization-run-create-a13",
                    "confirmedPayloadFingerprint":"visible-run-create-a13-v1"
                }
            }),
            settled_at: "2026-08-16T19:00:05.000Z".into(),
        };
        assert!(settle_ai_standard_result_effect_in_connection(&mut connection, &forged_create).is_err());
        let create_confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                effect_receipt: serde_json::json!({
                    "module":"experimentRun","entityType":"experimentRun","entityId":"run-created-a13",
                    "operation":"CREATE","service":"experimentRunService.createExperimentRun",
                    "canonicalReadback":{
                        "id":"run-created-a13","experimentId":"experiment-1","projectId":"project-1",
                        "operationId":"standard-result-run-create-a13",
                        "authorizationId":"authorization-run-create-a13",
                        "confirmedPayloadFingerprint":"visible-run-create-a13-v1"
                    }
                }),
                ..forged_create
            },
        )
        .unwrap();
        assert_eq!(create_confirmed.standard_results[0].disposition, "CONFIRMED");

        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &begin(
                "standard-result-run-update-a13",
                "visible-run-update-a13-v1",
                "authorization-run-update-a13",
                serde_json::json!({"title":"Update Run"}),
                "2026-08-16T19:00:06.000Z",
            ),
        )
        .unwrap();
        let forged_update = SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: "standard-result-run-update-a13".into(),
            authorization_id: "authorization-run-update-a13".into(),
            effect_receipt: serde_json::json!({
                "module":"experimentRun","entityType":"experimentRun","entityId":"run-forged",
                "operation":"UPDATE","service":"experimentRunService.updateExperimentRun",
                "canonicalReadback":{
                    "id":"run-forged","experimentId":"experiment-1","projectId":"project-1",
                    "operationId":"standard-result-run-update-a13",
                    "authorizationId":"authorization-run-update-a13",
                    "confirmedPayloadFingerprint":"visible-run-update-a13-v1"
                }
            }),
            settled_at: "2026-08-16T19:00:07.000Z".into(),
        };
        assert!(settle_ai_standard_result_effect_in_connection(&mut connection, &forged_update).is_err());
        let update_confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                effect_receipt: serde_json::json!({
                    "module":"experimentRun","entityType":"experimentRun","entityId":"run-1",
                    "operation":"UPDATE","service":"experimentRunService.updateExperimentRun",
                    "canonicalReadback":{
                        "id":"run-1","experimentId":"experiment-1","projectId":"project-1",
                        "operationId":"standard-result-run-update-a13",
                        "authorizationId":"authorization-run-update-a13",
                        "confirmedPayloadFingerprint":"visible-run-update-a13-v1"
                    }
                }),
                ..forged_update
            },
        )
        .unwrap();
        assert_eq!(update_confirmed.standard_results[1].disposition, "CONFIRMED");

        assert!(begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &begin(
                "standard-result-run-delete-a13",
                "visible-run-delete-a13-v1",
                "authorization-run-delete-a13",
                serde_json::json!({"reason":"Manual review only"}),
                "2026-08-16T19:00:08.000Z",
            ),
        )
        .is_err());

        drop(connection);
        let reopened = Connection::open(&path).expect("restart-equivalent A13 reopen");
        let readback = read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(readback.standard_results[1].disposition, "CONFIRMED");
        assert_eq!(readback.standard_results[2].disposition, "PENDING");
        assert_eq!(readback.standard_results[3].disposition, "PENDING");
        assert_eq!(
            readback.standard_results[1].effect_receipt.as_ref().unwrap()
                ["canonicalReadback"]["operationId"],
            "standard-result-run-update-a13"
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup A13 durable database");
    }

    #[test]
    fn a16_literature_create_update_require_exact_durable_tuples_and_operation_correlation() {
        let path = temporary_database_path("a16-literature-standard-result-correlation");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-a16-chat",
            "attempt-a16-chat",
            "message-a16-user",
            "2026-08-16T20:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a16-chat",
                "message-a16-assistant",
                "2026-08-16T20:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-a16-parse",
            "message-a16-user",
            "2026-08-16T20:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-a16-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(a16_literature_standard_result_batch(
                    "message-a16-user",
                    "2026-08-16T20:00:03.000Z",
                )),
                settled_at: "2026-08-16T20:00:03.000Z".into(),
            },
        )
        .unwrap();

        let begin = |result_id: &str,
                     fingerprint: &str,
                     authorization_id: &str,
                     payload: Value,
                     started_at: &str| BeginAIStandardResultConfirmationInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: result_id.into(),
            parse_call_attempt_id: "attempt-a16-parse".into(),
            expected_visible_payload_fingerprint: fingerprint.into(),
            authorization_id: authorization_id.into(),
            confirmed_payload: payload,
            confirmed_payload_fingerprint: fingerprint.into(),
            started_at: started_at.into(),
        };
        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &begin(
                "standard-result-literature-create-a16",
                "visible-literature-create-a16-v1",
                "authorization-literature-create-a16",
                serde_json::json!({"title":"Create Literature","authors":[],"keywords":[],"readingStatus":"unread","tags":[]}),
                "2026-08-16T20:00:04.000Z",
            ),
        )
        .unwrap();
        let create_readback = serde_json::json!({
            "id":"literature-created-a16","projectId":"project-1","primaryProjectId":null,
            "title":"Create Literature","authorNames":[],"year":null,"venue":null,
            "publicationType":null,"abstract":null,"keywords":[],"doi":null,
            "readingStatus":"unread","importance":null,"tags":[],
            "updatedAt":"2026-08-16T20:00:04.000Z",
            "operationKey":"a16-lit-create:standard-result-literature-create-a16:authorization-literature-create-a16",
            "resultId":"standard-result-literature-create-a16",
            "authorizationId":"authorization-literature-create-a16",
            "confirmedPayloadFingerprint":"visible-literature-create-a16-v1",
            "appliedUpdatedAt":"2026-08-16T20:00:04.000Z"
        });
        let forged_create = SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: "standard-result-literature-create-a16".into(),
            authorization_id: "authorization-literature-create-a16".into(),
            effect_receipt: serde_json::json!({
                "module":"literature","entityType":"literature","entityId":"literature-created-a16",
                "operation":"CREATE","service":"arbitraryService.write",
                "canonicalReadback":create_readback
            }),
            settled_at: "2026-08-16T20:00:05.000Z".into(),
        };
        assert!(settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &forged_create,
        )
        .is_err());
        let create_confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                effect_receipt: serde_json::json!({
                    "module":"literature","entityType":"literature","entityId":"literature-created-a16",
                    "operation":"CREATE","service":"literatureService.createLiteratureWithOperation",
                    "canonicalReadback":create_readback
                }),
                ..forged_create
            },
        )
        .unwrap();
        assert_eq!(create_confirmed.standard_results[0].disposition, "CONFIRMED");

        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &begin(
                "standard-result-literature-update-a16",
                "visible-literature-update-a16-v1",
                "authorization-literature-update-a16",
                serde_json::json!({"title":"Update Literature"}),
                "2026-08-16T20:00:06.000Z",
            ),
        )
        .unwrap();
        let mut update_readback = serde_json::json!({
            "id":"literature-1","projectId":"project-1","primaryProjectId":"project-1",
            "title":"Update Literature","authorNames":["Researcher"],"year":2026,"venue":"Venue",
            "publicationType":"journal_article","abstract":"Abstract","keywords":["keyword"],"doi":"10.1/a16",
            "readingStatus":"reading","importance":"important","tags":["tag"],
            "updatedAt":"2026-08-16T20:00:07.000Z",
            "operationKey":"forged-operation",
            "resultId":"standard-result-literature-update-a16",
            "authorizationId":"authorization-literature-update-a16",
            "confirmedPayloadFingerprint":"visible-literature-update-a16-v1",
            "appliedUpdatedAt":"2026-08-16T20:00:07.000Z"
        });
        let forged_update = SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: "standard-result-literature-update-a16".into(),
            authorization_id: "authorization-literature-update-a16".into(),
            effect_receipt: serde_json::json!({
                "module":"literature","entityType":"literature","entityId":"literature-1",
                "operation":"UPDATE","service":"literatureService.updateLiteratureWithExpectedUpdatedAtAndOperation",
                "canonicalReadback":update_readback
            }),
            settled_at: "2026-08-16T20:00:08.000Z".into(),
        };
        assert!(settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &forged_update,
        )
        .is_err());
        update_readback["operationKey"] = serde_json::json!(
            "a16-lit-update:standard-result-literature-update-a16:authorization-literature-update-a16"
        );
        let update_confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                effect_receipt: serde_json::json!({
                    "module":"literature","entityType":"literature","entityId":"literature-1",
                    "operation":"UPDATE","service":"literatureService.updateLiteratureWithExpectedUpdatedAtAndOperation",
                    "canonicalReadback":update_readback
                }),
                ..forged_update
            },
        )
        .unwrap();
        assert_eq!(update_confirmed.standard_results[1].disposition, "CONFIRMED");

        drop(connection);
        let reopened = Connection::open(&path).expect("restart-equivalent A16 reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(readback.standard_results[1].disposition, "CONFIRMED");
        assert_eq!(
            readback.standard_results[1].effect_receipt.as_ref().unwrap()
                ["canonicalReadback"]["operationKey"],
            "a16-lit-update:standard-result-literature-update-a16:authorization-literature-update-a16"
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn a11_experiment_primary_new_manuscript_requires_exact_durable_tuple_and_correlation() {
        let path = temporary_database_path("a11-experiment-manuscript-correlation");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-a11-chat",
            "attempt-a11-chat",
            "message-a11-user",
            "2026-08-16T08:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a11-chat",
                "message-a11-assistant",
                "2026-08-16T08:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-a11-parse",
            "message-a11-user",
            "2026-08-16T08:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-a11-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(a11_experiment_manuscript_standard_result_batch(
                    "message-a11-user",
                    "2026-08-16T08:00:03.000Z",
                )),
                settled_at: "2026-08-16T08:00:03.000Z".into(),
            },
        )
        .unwrap();

        let begin = |result_id: &str, authorization_id: &str| {
            BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: result_id.into(),
                parse_call_attempt_id: "attempt-a11-parse".into(),
                expected_visible_payload_fingerprint: format!("visible-{result_id}-v1"),
                authorization_id: authorization_id.into(),
                confirmed_payload: serde_json::json!({"body":"# Edited A11 body"}),
                confirmed_payload_fingerprint: format!("visible-{result_id}-v1"),
                started_at: "2026-08-16T08:00:04.000Z".into(),
            }
        };
        let result_id = "standard-result-experiment-manuscript-a11";
        let authorization_id = "authorization-experiment-manuscript-a11";
        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &begin(result_id, authorization_id),
        )
        .unwrap();
        let valid_receipt = serde_json::json!({
            "module":"experiment","entityType":"fileRef","entityId":"file-ref-a11",
            "operation":"NEW_MANUSCRIPT","service":"experimentManuscriptSaveAsAdapter.saveAs",
            "canonicalReadback":{
                "projectId":"project-1","experimentId":"experiment-1","manuscriptChannel":"primary",
                "resultId":result_id,"authorizationId":authorization_id,
                "operationId":format!("a11-exp-man:{result_id}:{authorization_id}"),
                "operationGeneration":1,
                "candidateRequestId":format!("a11-exp-man:{result_id}:{authorization_id}:1"),
                "candidateOccurredAt":"2026-08-16T08:00:05.000Z",
                "fileRefId":"file-ref-a11","resourceKind":"file","fileRole":"manuscript",
                "sourceFileRefId":"file-ref-source-a11",
                "sourcePathIdentityKey":"n:/managed/experiment-1/source-a11.md",
                "sourceDirectoryPathIdentityKey":"n:/managed/experiment-1",
                "candidatePathIdentityKey":"n:/managed/experiment-1/file-ref-a11.md",
                "candidateDirectoryPathIdentityKey":"n:/managed/experiment-1",
                "targetLocationMode":"managed","operationStage":"completed",
                "d1CommitState":"confirmed","d2CommitState":"confirmed",
                "confirmedPayloadFingerprint":format!("visible-{result_id}-v1"),
                "confirmedBodyFingerprint":"body-fingerprint-a11",
                "physicalBodyFingerprint":"body-fingerprint-a11",
                "physicalEncoding":"utf-8","documentLineEnding":"LF",
                "bindingPreserved":true,"currentChanged":false,"defaultChanged":false,
                "formalSwitchInvoked":false,
                "readbackState":"AUTHORITATIVE_FILE_REF_LIST_PHYSICAL_BODY_BINDING_PRESERVED"
            }
        });
        let settle = |receipt: Value| SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: result_id.into(),
            authorization_id: authorization_id.into(),
            effect_receipt: receipt,
            settled_at: "2026-08-16T08:00:05.000Z".into(),
        };
        for (pointer, forged_value) in [
            ("/service", serde_json::json!("arbitraryManuscriptService.write")),
            ("/operation", serde_json::json!("UPDATE")),
            ("/canonicalReadback/experimentId", serde_json::json!("experiment-2")),
            ("/canonicalReadback/manuscriptChannel", serde_json::json!("secondary")),
            ("/canonicalReadback/formalSwitchInvoked", serde_json::json!(true)),
            ("/canonicalReadback/targetLocationMode", serde_json::json!("external")),
            ("/canonicalReadback/candidateRequestId", serde_json::json!("unrelated:1")),
            ("/canonicalReadback/candidateDirectoryPathIdentityKey", serde_json::json!("n:/managed/other")),
        ] {
            let mut forged = valid_receipt.clone();
            *forged.pointer_mut(pointer).expect("forged receipt pointer") = forged_value;
            assert!(settle_ai_standard_result_effect_in_connection(
                &mut connection,
                &settle(forged),
            )
            .is_err());
        }

        let confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &settle(valid_receipt),
        )
        .unwrap();
        assert_eq!(confirmed.standard_results[0].disposition, "CONFIRMED");
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(
            readback.standard_results[0].effect_receipt.as_ref().unwrap()
                ["canonicalReadback"]["operationId"],
            format!("a11-exp-man:{result_id}:{authorization_id}")
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp13_d1_a6_quick_candidate_receipt_requires_run_source_binding_and_commit_correlation() {
        let path = temporary_database_path("d1-a6-quick-candidate-correlation");
        let mut connection = open_current_database(&path);
        let mut chat = prepare_input(
            "attempt-d1-a6-chat",
            "attempt-d1-a6-chat",
            "message-d1-a6-user",
            "2026-08-18T12:00:00.000Z",
        );
        chat.context_source_refs = serde_json::json!([
            {
                "module": "project",
                "entityType": "project",
                "entityId": "project-1",
                "sourceKind": "userAuthored"
            },
            quick_analysis_constraint_source_ref()
        ]);
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-d1-a6-chat",
                "message-d1-a6-assistant",
                "2026-08-18T12:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-d1-a6-parse",
            "message-d1-a6-user",
            "2026-08-18T12:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let mut batch = a11_experiment_manuscript_standard_result_batch(
            "message-d1-a6-user",
            "2026-08-18T12:00:03.000Z",
        );
        batch.results[0].source["quickAnalysisTarget"] = serde_json::json!({
            "ownerType":"experiment",
            "ownerId":"experiment-1",
            "channel":"primary",
            "projectOrScopeId":"project-1",
            "sourceFileRefId":"source-a6",
            "sourceDirectoryFileRefId":"folder-a6",
            "whitelistFingerprint":"quick-whitelist-a6"
        });
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-d1-a6-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch),
                settled_at: "2026-08-18T12:00:03.000Z".into(),
            },
        )
        .unwrap();

        let result_id = "standard-result-experiment-manuscript-a11";
        let run_id = "representative-run-a6";
        let authorization_id = format!("quick-analysis-run-authorization:{run_id}");
        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: result_id.into(),
                parse_call_attempt_id: "attempt-d1-a6-parse".into(),
                expected_visible_payload_fingerprint: format!("visible-{result_id}-v1"),
                authorization_id: authorization_id.clone(),
                confirmed_payload: serde_json::json!({"body":"# Edited A11 body"}),
                confirmed_payload_fingerprint: format!("visible-{result_id}-v1"),
                started_at: "2026-08-18T12:00:04.000Z".into(),
            },
        )
        .unwrap();
        let binding = serde_json::json!({
            "id":"binding-a6",
            "ownerType":"experiment",
            "ownerId":"experiment-1",
            "manuscriptChannel":"primary",
            "defaultFolderFileRefId":"folder-a6",
            "defaultManuscriptFileRefId":"source-a6",
            "currentFileRefId":"source-a6",
            "updatedAt":"2026-08-18T12:00:00.000Z"
        });
        let mut canonical_readback = serde_json::json!({
                "projectId":"project-1",
                "ownerType":"experiment",
                "ownerId":"experiment-1",
                "manuscriptChannel":"primary",
                "resultId":result_id,
                "authorizationId":authorization_id,
                "authorizationSource":"DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION",
                "quickAnalysisRunId":run_id,
                "operationId":format!("qa-candidate:{result_id}:quick-analysis-run-authorization:{run_id}"),
                "candidateRequestId":result_id,
                "fileRefId":"candidate-a6",
                "resourceKind":"file",
                "fileRole":"manuscript",
                "locationMode":"managed",
                "sourceFileRefId":"source-a6",
                "sourceDirectoryFileRefId":"folder-a6",
                "candidateDirectoryPathIdentityKey":"c:/labpod/project/experiment",
                "sourceDirectoryPathIdentityKey":"c:/labpod/project/experiment",
                "candidateDirectoryAgreement":true,
                "sourceFreshnessTokenBefore":"fresh-token-a6",
                "sourceFreshnessTokenAfter":"fresh-token-a6",
                "sourceFreshnessPreserved":true,
                "bindingBefore":binding,
                "bindingAfter":binding,
                "bindingPreserved":true,
                "currentChanged":false,
                "defaultChanged":false,
                "formalSwitchInvoked":false,
                "confirmedPayloadFingerprint":format!("visible-{result_id}-v1"),
                "confirmedBodyFingerprint":"body-fingerprint-a6",
                "physicalBodyFingerprint":"body-fingerprint-a6"
        });
        for (field, value) in [
            ("literatureSiblingChannel", Value::Null),
            ("literatureSiblingBindingBefore", Value::Null),
            ("literatureSiblingBindingAfter", Value::Null),
            ("literatureSiblingBindingPreserved", serde_json::json!(true)),
            ("physicalEncoding", serde_json::json!("utf-8")),
            ("physicalSizeBytes", serde_json::json!(120)),
            ("candidateTerminalCommitState", serde_json::json!("POST_PUBLISH_READBACK_CONFIRMED")),
            ("readbackState", serde_json::json!("CANDIDATE_FILE_REF_PHYSICAL_BODY_SOURCE_AND_BINDING_PRESERVED")),
        ] {
            canonical_readback[field] = value;
        }
        let valid_receipt = serde_json::json!({
            "module":"experiment",
            "entityType":"fileRef",
            "entityId":"candidate-a6",
            "operation":"NEW_MANUSCRIPT",
            "service":"candidateManuscriptService.saveCandidate",
            "canonicalReadback":canonical_readback
        });
        assert_eq!(
            valid_receipt["canonicalReadback"]
                .as_object()
                .expect("canonical readback object")
                .len(),
            39
        );
        let settle = |receipt: Value| SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: result_id.into(),
            authorization_id: authorization_id.clone(),
            effect_receipt: receipt,
            settled_at: "2026-08-18T12:00:05.000Z".into(),
        };
        for (pointer, forged_value) in [
            ("/canonicalReadback/projectId", serde_json::json!("project-other")),
            ("/canonicalReadback/quickAnalysisRunId", serde_json::json!("other-run")),
            ("/canonicalReadback/sourceFreshnessTokenAfter", serde_json::json!("stale-token")),
            ("/canonicalReadback/bindingAfter/currentFileRefId", serde_json::json!("candidate-a6")),
            ("/canonicalReadback/candidateDirectoryAgreement", serde_json::json!(false)),
            ("/canonicalReadback/formalSwitchInvoked", serde_json::json!(true)),
        ] {
            let mut forged = valid_receipt.clone();
            *forged.pointer_mut(pointer).expect("forged receipt pointer") = forged_value;
            assert!(settle_ai_standard_result_effect_in_connection(
                &mut connection,
                &settle(forged),
            )
            .is_err());
        }

        let confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &settle(valid_receipt),
        )
        .unwrap();
        assert_eq!(confirmed.standard_results[0].disposition, "CONFIRMED");
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(
            readback.standard_results[0].effect_receipt.as_ref().unwrap()
                ["canonicalReadback"]["quickAnalysisRunId"],
            run_id
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp13_d1_a19_ten_owner_channel_targets_require_exact_quick_source_identity() {
        let path = temporary_database_path("d1-a19-ten-targets");
        let mut connection = open_current_database(&path);
        let mut chat = prepare_input(
            "attempt-d1-a19-chat",
            "attempt-d1-a19-chat",
            "message-d1-a19-user",
            "2026-08-20T12:00:00.000Z",
        );
        chat.context_source_refs = serde_json::json!([{
            "module":"project","entityType":"project","entityId":"project-1",
            "sourceKind":"userAuthored"
        }, quick_analysis_constraint_source_ref()]);
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-d1-a19-chat",
                "message-d1-a19-assistant",
                "2026-08-20T12:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-d1-a19-parse",
            "message-d1-a19-user",
            "2026-08-20T12:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let existing = read_call_attempt_by_id(&connection, "attempt-d1-a19-parse").unwrap();
        let rows = [
            ("experiment", "experiment-1", "primary"),
            ("experimentRun", "run-1", "primary"),
            ("literature", "literature-1", "literature_outline"),
            ("literature", "literature-1", "dedicated_notes"),
            ("review", "review-1", "primary"),
            ("resultItem", "result-item-1", "primary"),
            ("finding", "finding-1", "primary"),
            ("outputCandidate", "output-candidate-1", "primary"),
            ("outputGap", "output-gap-1", "primary"),
            ("researchOutput", "research-output-1", "primary"),
        ];
        assert_eq!(rows.len(), 10);
        let mut representative = None;
        for (owner, owner_id, channel) in rows {
            assert!(is_canonical_quick_analysis_owner_channel(owner, Some(channel)));
            let mut batch = a11_experiment_manuscript_standard_result_batch(
                "message-d1-a19-user",
                "2026-08-20T12:00:03.000Z",
            );
            batch.id = format!("standard-result-batch-a19-{owner}-{channel}");
            batch.results[0].id = format!("standard-result-a19-{owner}-{channel}");
            batch.results[0].visible_payload_fingerprint =
                format!("visible-a19-{owner}-{channel}");
            batch.results[0].target = serde_json::json!({
                "module":owner,"projectId":"project-1","entityType":owner,
                "entityId":owner_id,"manuscriptChannel":channel
            });
            if owner == "experimentRun" {
                batch.results[0].source["selectedExperimentRunIds"] =
                    serde_json::json!([owner_id]);
                batch.results[0].source["experimentRunParentRelations"] = serde_json::json!([{
                    "runId":owner_id,"parentExperimentId":"experiment-1",
                    "projectId":"project-1","selectionOrder":0
                }]);
            }
            if owner == "literature" {
                batch.results[0].source["selectedLiteratureIds"] =
                    serde_json::json!([owner_id]);
                batch.results[0].source["literatureAssociationTuples"] = serde_json::json!([{
                    "literatureId":owner_id,
                    "projectAssociationKind":"assigned",
                    "canonicalProjectId":"project-1",
                    "conversationProjectEligibilityDisposition":"allowed_same_project",
                    "lifecycleEligibility":"eligible",
                    "selectionOrder":0,
                    "normalizedProjectionFingerprint":"literature-a19"
                }]);
            }
            batch.results[0].source["quickAnalysisTarget"] = serde_json::json!({
                "ownerType":owner,
                "ownerId":owner_id,
                "channel":channel,
                "projectOrScopeId":"project-1",
                "sourceFileRefId":format!("source-a19-{owner}-{channel}"),
                "sourceDirectoryFileRefId":format!("folder-a19-{owner}"),
                "whitelistFingerprint":format!("whitelist-a19-{owner}-{channel}")
            });
            validate_standard_result_batch(&existing, &batch)
                .unwrap_or_else(|error| panic!("{owner}/{channel} must be admitted: {error}"));
            if owner == "researchOutput" {
                representative = Some(batch);
            }
        }
        for unsupported in [
            ("wrong-channel", "/target/manuscriptChannel", serde_json::json!("dedicated_notes")),
            ("wrong-owner-id", "/source/quickAnalysisTarget/ownerId", serde_json::json!("other-output")),
            ("wrong-scope", "/source/quickAnalysisTarget/projectOrScopeId", serde_json::json!("project-2")),
            ("wrong-owner-type", "/source/quickAnalysisTarget/ownerType", serde_json::json!("finding")),
        ] {
            let mut forged = representative.clone().expect("representative A19 target");
            let pointer = unsupported.1.strip_prefix("/source").unwrap_or(unsupported.1);
            if unsupported.1.starts_with("/source") {
                *forged.results[0].source.pointer_mut(pointer).expect("source pointer") = unsupported.2;
            } else {
                *forged.results[0].target.pointer_mut(unsupported.1.strip_prefix("/target").unwrap())
                    .expect("target pointer") = unsupported.2;
            }
            assert!(
                validate_standard_result_batch(&existing, &forged).is_err(),
                "{} must fail closed",
                unsupported.0
            );
        }
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn lp13_d1_a19_finding_new_manuscript_receipt_is_not_finding_create_or_experiment() {
        let path = temporary_database_path("d1-a19-finding-receipt");
        let mut connection = open_current_database(&path);
        let mut chat = prepare_input(
            "attempt-d1-a19-finding-chat",
            "attempt-d1-a19-finding-chat",
            "message-d1-a19-finding-user",
            "2026-08-20T13:00:00.000Z",
        );
        chat.context_source_refs = serde_json::json!([{
            "module":"project","entityType":"project","entityId":"project-1",
            "sourceKind":"userAuthored"
        }, quick_analysis_constraint_source_ref()]);
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-d1-a19-finding-chat",
                "message-d1-a19-finding-assistant",
                "2026-08-20T13:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-d1-a19-finding-parse",
            "message-d1-a19-finding-user",
            "2026-08-20T13:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let result_id = "standard-result-finding-manuscript-a19";
        let mut batch = a11_experiment_manuscript_standard_result_batch(
            "message-d1-a19-finding-user",
            "2026-08-20T13:00:03.000Z",
        );
        batch.id = "standard-result-batch-finding-a19".into();
        batch.results[0].id = result_id.into();
        batch.results[0].target = serde_json::json!({
            "module":"finding","projectId":"project-1","entityType":"finding",
            "entityId":"finding-a19","manuscriptChannel":"primary"
        });
        batch.results[0].source["quickAnalysisTarget"] = serde_json::json!({
            "ownerType":"finding","ownerId":"finding-a19","channel":"primary",
            "projectOrScopeId":"project-1","sourceFileRefId":"source-finding-a19",
            "sourceDirectoryFileRefId":"folder-finding-a19",
            "whitelistFingerprint":"whitelist-finding-a19"
        });
        batch.results[0].visible_payload_fingerprint = "visible-finding-a19".into();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-d1-a19-finding-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch),
                settled_at: "2026-08-20T13:00:03.000Z".into(),
            },
        )
        .unwrap();
        let run_id = "representative-finding-run-a19";
        let authorization_id = format!("quick-analysis-run-authorization:{run_id}");
        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: result_id.into(),
                parse_call_attempt_id: "attempt-d1-a19-finding-parse".into(),
                expected_visible_payload_fingerprint: "visible-finding-a19".into(),
                authorization_id: authorization_id.clone(),
                confirmed_payload: serde_json::json!({"body":"# Finding A19"}),
                confirmed_payload_fingerprint: "visible-finding-a19".into(),
                started_at: "2026-08-20T13:00:04.000Z".into(),
            },
        )
        .unwrap();
        let binding = serde_json::json!({
            "id":"binding-finding-a19","ownerType":"finding","ownerId":"finding-a19",
            "manuscriptChannel":"primary","defaultFolderFileRefId":"folder-finding-a19",
            "defaultManuscriptFileRefId":"source-finding-a19",
            "currentFileRefId":"source-finding-a19","updatedAt":"2026-08-20T13:00:00.000Z"
        });
        let mut canonical = serde_json::json!({
            "projectId":"project-1","ownerType":"finding","ownerId":"finding-a19",
            "manuscriptChannel":"primary","resultId":result_id,
            "authorizationId":authorization_id,
            "authorizationSource":"DERIVED_FROM_QUICK_ANALYSIS_RUN_AUTHORIZATION",
            "quickAnalysisRunId":run_id,
            "operationId":format!("qa-candidate:{result_id}:quick-analysis-run-authorization:{run_id}"),
            "candidateRequestId":result_id,"fileRefId":"candidate-finding-a19",
            "resourceKind":"file","fileRole":"manuscript","locationMode":"managed",
            "sourceFileRefId":"source-finding-a19",
            "sourceDirectoryFileRefId":"folder-finding-a19",
            "candidateDirectoryPathIdentityKey":"c:/labpod/project/finding",
            "sourceDirectoryPathIdentityKey":"c:/labpod/project/finding",
            "candidateDirectoryAgreement":true,
            "sourceFreshnessTokenBefore":"fresh-finding-a19",
            "sourceFreshnessTokenAfter":"fresh-finding-a19","sourceFreshnessPreserved":true,
            "bindingBefore":binding,"bindingAfter":binding,"bindingPreserved":true,
            "currentChanged":false,"defaultChanged":false,"formalSwitchInvoked":false,
            "confirmedPayloadFingerprint":"visible-finding-a19",
            "confirmedBodyFingerprint":"body-finding-a19",
            "physicalBodyFingerprint":"body-finding-a19"
        });
        for (field, value) in [
            ("literatureSiblingChannel", Value::Null),
            ("literatureSiblingBindingBefore", Value::Null),
            ("literatureSiblingBindingAfter", Value::Null),
            ("literatureSiblingBindingPreserved", serde_json::json!(true)),
            ("physicalEncoding", serde_json::json!("utf-8")),
            ("physicalSizeBytes", serde_json::json!(120)),
            ("candidateTerminalCommitState", serde_json::json!("POST_PUBLISH_READBACK_CONFIRMED")),
            ("readbackState", serde_json::json!("CANDIDATE_FILE_REF_PHYSICAL_BODY_SOURCE_AND_BINDING_PRESERVED")),
        ] {
            canonical[field] = value;
        }
        assert_eq!(canonical.as_object().unwrap().len(), 39);
        let valid_receipt = serde_json::json!({
            "module":"finding","entityType":"fileRef","entityId":"candidate-finding-a19",
            "operation":"NEW_MANUSCRIPT","service":"candidateManuscriptService.saveCandidate",
            "canonicalReadback":canonical
        });
        let settle = |receipt: Value| SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: result_id.into(),
            authorization_id: authorization_id.clone(),
            effect_receipt: receipt,
            settled_at: "2026-08-20T13:00:05.000Z".into(),
        };
        for (pointer, forged) in [
            ("/module", serde_json::json!("experiment")),
            ("/operation", serde_json::json!("CREATE")),
            ("/canonicalReadback/ownerId", serde_json::json!("finding-other")),
        ] {
            let mut receipt = valid_receipt.clone();
            *receipt.pointer_mut(pointer).unwrap() = forged;
            assert!(settle_ai_standard_result_effect_in_connection(
                &mut connection,
                &settle(receipt),
            )
            .is_err());
        }
        let confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &settle(valid_receipt),
        )
        .unwrap();
        assert_eq!(confirmed.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(
            confirmed.standard_results[0].effect_receipt.as_ref().unwrap()["module"],
            "finding"
        );
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn a14_experiment_run_primary_new_manuscript_requires_exact_durable_tuple_and_correlation() {
        let path = temporary_database_path("a14-run-manuscript-correlation");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-a14-chat",
            "attempt-a14-chat",
            "message-a14-user",
            "2026-08-16T20:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a14-chat",
                "message-a14-assistant",
                "2026-08-16T20:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-a14-parse",
            "message-a14-user",
            "2026-08-16T20:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-a14-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(a14_experiment_run_manuscript_standard_result_batch(
                    "message-a14-user",
                    "2026-08-16T20:00:03.000Z",
                )),
                settled_at: "2026-08-16T20:00:03.000Z".into(),
            },
        )
        .unwrap();

        let result_id = "standard-result-run-manuscript-a14";
        let authorization_id = "authorization-run-manuscript-a14";
        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: result_id.into(),
                parse_call_attempt_id: "attempt-a14-parse".into(),
                expected_visible_payload_fingerprint: "visible-run-manuscript-a14-v1".into(),
                authorization_id: authorization_id.into(),
                confirmed_payload: serde_json::json!({"body":"# Edited A14 Run body"}),
                confirmed_payload_fingerprint: "visible-run-manuscript-a14-v1".into(),
                started_at: "2026-08-16T20:00:04.000Z".into(),
            },
        )
        .unwrap();
        let binding_readback = serde_json::json!({
            "id":"binding-a14","ownerType":"experimentRun","ownerId":"run-1",
            "manuscriptChannel":"primary","defaultFolderFileRefId":"folder-a14",
            "defaultManuscriptFileRefId":"file-default-a14",
            "currentFileRefId":"file-current-a14","updatedAt":"2026-08-16T20:00:00.000Z"
        });
        let mut canonical_readback = serde_json::json!({
            "projectId":"project-1","runId":"run-1","parentExperimentId":"experiment-1",
            "manuscriptChannel":"primary","resultId":result_id,"authorizationId":authorization_id,
            "authorizationFingerprint":"lp13-a6-a14a14a1",
            "operationId":format!("a14-run-man:{result_id}:{authorization_id}"),
            "operationGeneration":1,
            "fileRefId":"file-ref-a14","artifactAssociation":"INDEPENDENT_MANAGED_MANUSCRIPT",
            "candidateRequestId":format!("a14-run-man:{result_id}:{authorization_id}:1"),
            "candidateOccurredAt":"2026-08-16T20:00:03.500Z",
            "targetIdentityDigest":"lp13-a6-b14b14b1","resourceKind":"file","fileRole":"manuscript",
            "targetLocationMode":"managed","operationStage":"completed",
            "d1CommitState":"confirmed","d2CommitState":"confirmed",
            "confirmedPayloadFingerprint":"visible-run-manuscript-a14-v1"
        });
        let preservation_readback = serde_json::json!({
            "latestVisibleSourceBodyFingerprint":"body-fingerprint-a14",
            "confirmedBodyFingerprint":"body-fingerprint-a14",
            "physicalBodyFingerprint":"body-fingerprint-a14",
            "physicalEncoding":"utf-8","physicalSizeBytes":24,
            "bodyNormalization":"CRLF_TO_LF","documentLineEnding":"LF",
            "documentTerminalNewline":"one LF for the complete LabPod Markdown document",
            "preservationProofMode":"CANONICAL_OPERATION_CONTRACT_NO_BINDING_WRITE_PLUS_EXACT_OPERATION_READBACK",
            "preservationOperationSourceFileRefId":"file-current-a14",
            "bindingReadback":binding_readback,
            "previousCurrentFileRefId":"file-current-a14",
            "previousCurrentBodyFingerprint":"previous-body-fingerprint-a14",
            "preEffectBaselineSource":"CONFIRM_TIME_RUNTIME_BASELINE",
            "firstProvisioningDisposition":"NOT_APPLICABLE_WITH_CURRENT_RUN_CREATION_CONTRACT",
            "bindingPreserved":true,"currentChanged":false,"defaultChanged":false,
            "formalSwitchInvoked":false,
            "readbackState":"AUTHORITATIVE_RUN_FILE_REF_LIST_PHYSICAL_BODY_BINDING_PRESERVED"
        });
        canonical_readback
            .as_object_mut()
            .unwrap()
            .extend(preservation_readback.as_object().unwrap().clone());
        let valid_receipt = serde_json::json!({
            "module":"experimentRun","entityType":"fileRef","entityId":"file-ref-a14",
            "operation":"NEW_MANUSCRIPT","service":"experimentRunManuscriptSaveAsAdapter.saveAs",
            "canonicalReadback":canonical_readback
        });
        let settle = |receipt: Value| SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: result_id.into(),
            authorization_id: authorization_id.into(),
            effect_receipt: receipt,
            settled_at: "2026-08-16T20:00:05.000Z".into(),
        };
        for (pointer, forged_value) in [
            ("/service", serde_json::json!("arbitraryRunManuscriptService.write")),
            ("/canonicalReadback/runId", serde_json::json!("run-2")),
            ("/canonicalReadback/parentExperimentId", serde_json::json!("experiment-2")),
            ("/canonicalReadback/manuscriptChannel", serde_json::json!("secondary")),
            ("/canonicalReadback/formalSwitchInvoked", serde_json::json!(true)),
            ("/canonicalReadback/targetLocationMode", serde_json::json!("external")),
            ("/canonicalReadback/targetIdentityDigest", serde_json::json!("n:\\managed\\run-new.md")),
            ("/canonicalReadback/preservationProofMode", serde_json::json!("synthetic")),
            ("/canonicalReadback/latestVisibleSourceBodyFingerprint", serde_json::json!("stale-body")),
            ("/canonicalReadback/documentTerminalNewline", serde_json::json!("none")),
            ("/canonicalReadback/preservationOperationSourceFileRefId", serde_json::json!("file-other")),
            ("/canonicalReadback/bindingReadback/currentFileRefId", serde_json::json!("file-other")),
            ("/canonicalReadback/candidateRequestId", serde_json::json!("forged-candidate")),
        ] {
            let mut forged = valid_receipt.clone();
            *forged.pointer_mut(pointer).expect("forged A14 receipt pointer") = forged_value;
            assert!(settle_ai_standard_result_effect_in_connection(
                &mut connection,
                &settle(forged),
            )
            .is_err());
        }
        let confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &settle(valid_receipt),
        )
        .unwrap();
        assert_eq!(confirmed.standard_results[0].disposition, "CONFIRMED");
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent A14 reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(
            readback.standard_results[0].effect_receipt.as_ref().unwrap()
                ["canonicalReadback"]["operationId"],
            format!("a14-run-man:{result_id}:{authorization_id}")
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup A14 database");
    }

    fn assert_literature_exact_channel_new_manuscript_durable_tuple(
        channel: &str,
        task_label: &str,
    ) {
        let is_outline = channel == "literature_outline";
        let other_channel = if is_outline { "dedicated_notes" } else { "literature_outline" };
        let operation_prefix = if is_outline { "a17-lit-outline-man" } else { "a18-lit-notes-man" };
        let result_id = if is_outline {
            "standard-result-literature-outline-manuscript-a17"
        } else {
            "standard-result-literature-dedicated-notes-manuscript-a18"
        };
        let authorization_id = if is_outline {
            "authorization-literature-outline-a17"
        } else {
            "authorization-literature-dedicated-notes-a18"
        };
        let visible_payload_fingerprint = if is_outline {
            "visible-literature-outline-a17-v1"
        } else {
            "visible-literature-dedicated-notes-a18-v1"
        };
        let body = if is_outline {
            "# Edited A17 Literature outline"
        } else {
            "# Edited A18 Literature dedicated notes"
        };
        let file_ref_id = if is_outline { "file-ref-a17" } else { "file-ref-a18" };
        let preservation_source_file_ref_id = if is_outline {
            "outline-current-a17"
        } else {
            "notes-current-a17"
        };
        let readback_state = if is_outline {
            "AUTHORITATIVE_LITERATURE_OUTLINE_FILE_REF_LIST_PHYSICAL_BODY_DUAL_CHANNEL_BINDING_PRESERVED"
        } else {
            "AUTHORITATIVE_LITERATURE_DEDICATED_NOTES_FILE_REF_LIST_PHYSICAL_BODY_DUAL_CHANNEL_BINDING_PRESERVED"
        };
        let path = temporary_database_path(&format!("{task_label}-literature-manuscript-correlation"));
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-a17-chat",
            "attempt-a17-chat",
            "message-a17-user",
            "2026-08-16T21:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a17-chat",
                "message-a17-assistant",
                "2026-08-16T21:00:01.000Z",
            ),
        )
        .unwrap();
        let parse = prepare_parse_attempt_input(
            "attempt-a17-parse",
            "message-a17-user",
            "2026-08-16T21:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-a17-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(
                    literature_exact_channel_manuscript_standard_result_batch(
                        "message-a17-user",
                        "2026-08-16T21:00:03.000Z",
                        channel,
                        result_id,
                        body,
                        visible_payload_fingerprint,
                    ),
                ),
                settled_at: "2026-08-16T21:00:03.000Z".into(),
            },
        )
        .unwrap();

        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: result_id.into(),
                parse_call_attempt_id: "attempt-a17-parse".into(),
                expected_visible_payload_fingerprint: visible_payload_fingerprint.into(),
                authorization_id: authorization_id.into(),
                confirmed_payload: serde_json::json!({"body":body}),
                confirmed_payload_fingerprint: visible_payload_fingerprint.into(),
                started_at: "2026-08-16T21:00:04.000Z".into(),
            },
        )
        .unwrap();

        let outline_binding = serde_json::json!({
            "id":"binding-outline-a17","ownerType":"literature","ownerId":"literature-1",
            "manuscriptChannel":"literature_outline","defaultFolderFileRefId":"folder-outline-a17",
            "defaultManuscriptFileRefId":"outline-default-a17","currentFileRefId":"outline-current-a17",
            "updatedAt":"2026-08-16T21:00:00.000Z"
        });
        let notes_binding = serde_json::json!({
            "id":"binding-notes-a17","ownerType":"literature","ownerId":"literature-1",
            "manuscriptChannel":"dedicated_notes","defaultFolderFileRefId":"folder-notes-a17",
            "defaultManuscriptFileRefId":"notes-default-a17","currentFileRefId":"notes-current-a17",
            "updatedAt":"2026-08-16T21:00:00.000Z"
        });
        let mut canonical_readback = serde_json::json!({
            "projectId":"project-1","literatureId":"literature-1","primaryProjectId":"project-1",
            "manuscriptChannel":channel,"resultId":result_id,
            "authorizationId":authorization_id,"authorizationFingerprint":"lp13-a6-a17a17a1",
            "operationId":format!("{operation_prefix}:{result_id}:{authorization_id}"),
            "operationGeneration":1,
            "candidateRequestId":format!("{operation_prefix}:{result_id}:{authorization_id}:1"),
            "candidateOccurredAt":"2026-08-16T21:00:04.500Z",
            "fileRefId":file_ref_id,"artifactAssociation":"INDEPENDENT_MANAGED_MANUSCRIPT",
            "targetIdentityDigest":"lp13-a6-b17b17b1","resourceKind":"file","fileRole":"manuscript",
            "targetLocationMode":"managed","operationStage":"completed",
            "d1CommitState":"confirmed","d2CommitState":"confirmed",
            "confirmedPayloadFingerprint":visible_payload_fingerprint
        });
        let physical_readback = serde_json::json!({
            "latestVisibleSourceBodyFingerprint":"body-fingerprint-a17",
            "confirmedBodyFingerprint":"body-fingerprint-a17",
            "physicalBodyFingerprint":"body-fingerprint-a17","physicalEncoding":"utf-8",
            "physicalSizeBytes":34,"bodyNormalization":"CRLF_TO_LF","documentLineEnding":"LF",
            "documentTerminalNewline":"one LF for the complete LabPod Markdown document",
            "preservationProofMode":"CANONICAL_OPERATION_CONTRACT_NO_BINDING_WRITE_PLUS_DUAL_CHANNEL_EXACT_READBACK",
            "preservationOperationSourceFileRefId":preservation_source_file_ref_id,
            "outlineBindingReadback":outline_binding,"dedicatedNotesBindingReadback":notes_binding
        });
        let preservation_readback = serde_json::json!({
            "previousOutlineCurrentFileRefId":"outline-current-a17",
            "previousOutlineCurrentBodyFingerprint":"outline-body-before-a17",
            "previousDedicatedNotesCurrentFileRefId":"notes-current-a17",
            "previousDedicatedNotesCurrentBodyFingerprint":"notes-body-before-a17",
            "outlineManuscriptCount":if is_outline { 2 } else { 1 },
            "dedicatedNotesManuscriptCount":if is_outline { 1 } else { 2 },
            "preEffectBaselineSource":"CONFIRM_TIME_DUAL_CHANNEL_BASELINE",
            "firstProvisioningDisposition":"NOT_APPLICABLE_WITH_CURRENT_CONTRACT",
            "outlineBindingPreserved":true,"dedicatedNotesPreserved":true,
            "currentChanged":false,"defaultChanged":false,"formalSwitchInvoked":false,
            "readbackState":readback_state
        });
        canonical_readback
            .as_object_mut()
            .unwrap()
            .extend(physical_readback.as_object().unwrap().clone());
        canonical_readback
            .as_object_mut()
            .unwrap()
            .extend(preservation_readback.as_object().unwrap().clone());
        let valid_receipt = serde_json::json!({
            "module":"literature","entityType":"fileRef","entityId":file_ref_id,
            "operation":"NEW_MANUSCRIPT","service":"literatureManuscriptSaveAsAdapter.saveAs",
            "canonicalReadback":canonical_readback
        });
        let settle = |receipt: Value| SettleAIStandardResultEffectInput {
            conversation_id: CURRENT_CONVERSATION_ID.into(),
            result_id: result_id.into(),
            authorization_id: authorization_id.into(),
            effect_receipt: receipt,
            settled_at: "2026-08-16T21:00:05.000Z".into(),
        };
        for (pointer, forged_value) in [
            ("/service", serde_json::json!("privateLiteratureWriter.save")),
            ("/canonicalReadback/manuscriptChannel", serde_json::json!(other_channel)),
            ("/canonicalReadback/literatureId", serde_json::json!("literature-2")),
            ("/canonicalReadback/formalSwitchInvoked", serde_json::json!(true)),
            ("/canonicalReadback/targetLocationMode", serde_json::json!("external")),
            ("/canonicalReadback/outlineBindingPreserved", serde_json::json!(false)),
            ("/canonicalReadback/dedicatedNotesPreserved", serde_json::json!(false)),
            ("/canonicalReadback/previousDedicatedNotesCurrentFileRefId", serde_json::json!("notes-other")),
            ("/canonicalReadback/operationGeneration", serde_json::json!(0)),
            ("/canonicalReadback/candidateRequestId", serde_json::json!("forged-candidate")),
            ("/canonicalReadback/candidateOccurredAt", serde_json::json!("")),
        ] {
            let mut forged = valid_receipt.clone();
            *forged.pointer_mut(pointer).expect("forged exact-channel Literature receipt pointer") = forged_value;
            assert!(settle_ai_standard_result_effect_in_connection(
                &mut connection,
                &settle(forged),
            )
            .is_err());
        }
        let confirmed = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &settle(valid_receipt),
        )
        .unwrap();
        assert_eq!(confirmed.standard_results[0].disposition, "CONFIRMED");
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent Literature manuscript reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.standard_results[0].disposition, "CONFIRMED");
        assert_eq!(
            readback.standard_results[0].effect_receipt.as_ref().unwrap()
                ["canonicalReadback"]["operationId"],
            format!("{operation_prefix}:{result_id}:{authorization_id}")
        );
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup Literature manuscript database");
    }

    #[test]
    fn a17_literature_outline_new_manuscript_requires_exact_durable_tuple_and_dual_channel_preservation() {
        assert_literature_exact_channel_new_manuscript_durable_tuple(
            "literature_outline",
            "a17-literature-outline",
        );
    }

    #[test]
    fn a18_literature_dedicated_notes_new_manuscript_requires_exact_durable_tuple_and_dual_channel_preservation() {
        assert_literature_exact_channel_new_manuscript_durable_tuple(
            "dedicated_notes",
            "a18-literature-dedicated-notes",
        );
    }

    #[test]
    fn lp14_a1_b14_same_batch_experiment_run_parent_is_exact_ordered_and_durable() {
        let path = temporary_database_path("lp14-a1-b14-sibling-parent");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-b14-chat",
            "request-b14-chat",
            "message-b14-user",
            "2026-08-25T12:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-b14-chat",
                "message-b14-answer",
                "2026-08-25T12:00:01.000Z",
            ),
        )
        .unwrap();
        let prepared = prepare_ai_call_attempt_in_connection(
            &mut connection,
            &prepare_parse_attempt_input(
                "attempt-b14-parse",
                "message-b14-user",
                "2026-08-25T12:00:02.000Z",
            ),
        )
        .unwrap();
        let existing = prepared
            .readback
            .call_attempts
            .iter()
            .find(|attempt| attempt.id == "attempt-b14-parse")
            .expect("prepared B14 Parse Attempt")
            .clone();
        let source = parse_source_snapshot("message-b14-user");
        let mk_result = |id: &str,
                         ordinal: i64,
                         module: &str,
                         entity_type: &str,
                         title: &str,
                         metadata: Value,
                         issues: Value| NewAIStandardResultInput {
            id: id.into(),
            ordinal,
            category: "DATA_OPERATION".into(),
            action: "CREATE".into(),
            target: serde_json::json!({
                "module": module,
                "projectId": "project-1",
                "entityType": entity_type
            }),
            source: source.clone(),
            original_payload: serde_json::json!({"title": title, "_labpod": metadata}),
            visible_payload: serde_json::json!({"title": title}),
            visible_payload_fingerprint: format!("visible-b14-{ordinal}"),
            target_snapshot_fingerprint: None,
            validation_issues: issues,
        };
        let batch = NewAIStandardResultBatchInput {
            id: "batch-b14-sibling-parent".into(),
            results: vec![
                mk_result(
                    "result-b14-experiment",
                    1,
                    "experiment",
                    "experiment",
                    "B14 Experiment",
                    serde_json::json!({
                        "protocol":"labpod-standard-result-proposal-v1",
                        "originalOrdinal":1,
                        "proposalRef":"proposal-1"
                    }),
                    serde_json::json!([]),
                ),
                mk_result(
                    "result-b14-run",
                    2,
                    "experimentRun",
                    "experimentRun",
                    "B14 Run",
                    serde_json::json!({
                        "protocol":"labpod-standard-result-proposal-v1",
                        "originalOrdinal":2,
                        "proposalRef":"proposal-2",
                        "parentProposalRef":"proposal-1"
                    }),
                    serde_json::json!([{
                        "code":"EXPERIMENT_RUN_SIBLING_PARENT_PENDING",
                        "message":"Parent will bind from the exact earlier receipt."
                    }]),
                ),
                mk_result(
                    "result-b14-review",
                    3,
                    "review",
                    "review",
                    "B14 Review",
                    serde_json::json!({
                        "protocol":"labpod-standard-result-proposal-v1",
                        "originalOrdinal":3,
                        "proposalRef":"proposal-3"
                    }),
                    serde_json::json!([]),
                ),
            ],
            created_at: "2026-08-25T12:00:03.000Z".into(),
        };
        validate_standard_result_batch(&existing, &batch).unwrap();
        let mut forged = batch.clone();
        forged.results[1].original_payload["_labpod"]["parentProposalRef"] =
            serde_json::json!("proposal-missing");
        assert!(validate_standard_result_batch(&existing, &forged).is_err());

        let settled = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-b14-parse".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch),
                settled_at: "2026-08-25T12:00:03.000Z".into(),
            },
        )
        .unwrap();
        assert_eq!(settled.standard_results.len(), 3);
        assert_eq!(
            settled
                .standard_results
                .iter()
                .map(|result| result.ordinal)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(
            settled.standard_results[1].original_payload["_labpod"]
                ["parentProposalRef"],
            serde_json::json!("proposal-1")
        );
        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "result-b14-experiment".into(),
                parse_call_attempt_id: "attempt-b14-parse".into(),
                expected_visible_payload_fingerprint: "visible-b14-1".into(),
                authorization_id: "authorization-b14-experiment".into(),
                confirmed_payload: serde_json::json!({"title":"B14 Experiment"}),
                confirmed_payload_fingerprint: "visible-b14-1".into(),
                started_at: "2026-08-25T12:00:04.000Z".into(),
            },
        )
        .unwrap();
        settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "result-b14-experiment".into(),
                authorization_id: "authorization-b14-experiment".into(),
                effect_receipt: serde_json::json!({
                    "module":"experiment",
                    "entityType":"experiment",
                    "entityId":"experiment-domain-b14",
                    "operation":"CREATE",
                    "service":"experimentService.createExperiment",
                    "canonicalReadback":{
                        "id":"experiment-domain-b14",
                        "projectId":"project-1",
                        "operationId":"result-b14-experiment",
                        "authorizationId":"authorization-b14-experiment",
                        "confirmedPayloadFingerprint":"visible-b14-1"
                    }
                }),
                settled_at: "2026-08-25T12:00:05.000Z".into(),
            },
        )
        .unwrap();
        begin_ai_standard_result_confirmation_in_connection(
            &mut connection,
            &BeginAIStandardResultConfirmationInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "result-b14-run".into(),
                parse_call_attempt_id: "attempt-b14-parse".into(),
                expected_visible_payload_fingerprint: "visible-b14-2".into(),
                authorization_id: "authorization-b14-run".into(),
                confirmed_payload: serde_json::json!({"title":"B14 Run"}),
                confirmed_payload_fingerprint: "visible-b14-2".into(),
                started_at: "2026-08-25T12:00:06.000Z".into(),
            },
        )
        .unwrap();
        let confirmed_run = settle_ai_standard_result_effect_in_connection(
            &mut connection,
            &SettleAIStandardResultEffectInput {
                conversation_id: CURRENT_CONVERSATION_ID.into(),
                result_id: "result-b14-run".into(),
                authorization_id: "authorization-b14-run".into(),
                effect_receipt: serde_json::json!({
                    "module":"experimentRun",
                    "entityType":"experimentRun",
                    "entityId":"experiment-run-domain-b14",
                    "operation":"CREATE",
                    "service":"experimentRunService.createExperimentRun",
                    "canonicalReadback":{
                        "id":"experiment-run-domain-b14",
                        "projectId":"project-1",
                        "experimentId":"experiment-domain-b14",
                        "operationId":"result-b14-run",
                        "authorizationId":"authorization-b14-run",
                        "confirmedPayloadFingerprint":"visible-b14-2"
                    }
                }),
                settled_at: "2026-08-25T12:00:07.000Z".into(),
            },
        )
        .expect("same-batch Run receipt must derive its exact parent from the earlier Experiment receipt");
        assert_eq!(confirmed_run.standard_results[1].disposition, "CONFIRMED");
        assert_eq!(
            confirmed_run.standard_results[1].effect_receipt.as_ref().unwrap()
                ["canonicalReadback"]["experimentId"],
            "experiment-domain-b14"
        );
        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup B14 sibling database");
    }

    #[test]
    fn a6_parse_context_request_approval_preserves_purpose_and_result_correlation() {
        let path = temporary_database_path("a6-parse-context-request-followup");
        let mut connection = open_current_database(&path);
        let chat = prepare_input(
            "attempt-a6-context-chat",
            "attempt-a6-context-chat",
            "message-a6-context-user",
            "2026-08-15T16:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &chat).unwrap();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &settle_success_input(
                "attempt-a6-context-chat",
                "message-a6-context-answer",
                "2026-08-15T16:00:01.000Z",
            ),
        )
        .unwrap();

        let parse = prepare_parse_attempt_input(
            "attempt-a6-context-parse",
            "message-a6-context-user",
            "2026-08-15T16:00:02.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &parse).unwrap();
        let candidate = identity_context_request_candidate();
        let pending = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &context_request_success_input(
                "attempt-a6-context-parse",
                "message-a6-context-request",
                "context-request-a6-parse",
                serde_json::json!([{
                    "refKind":"AI_RESEARCH_OBJECT",
                    "refId":"task-2",
                    "contributionKind":"IDENTITY_METADATA"
                }]),
                serde_json::json!([candidate.clone()]),
                serde_json::json!([{
                    "refKind":"AI_RESEARCH_OBJECT",
                    "refId":"task-2",
                    "projectId":"project-1",
                    "label":"Task Two",
                    "entityType":"task",
                    "allowedContributionKinds":["IDENTITY_METADATA"]
                }]),
                "2026-08-15T16:00:03.000Z",
            ),
        )
        .unwrap();
        assert_eq!(pending.context_requests[0].state, "PENDING");
        assert_eq!(pending.projected_messages.len(), 2);
        assert_eq!(pending.messages.len(), 3);

        let mut followup = context_request_followup_input(
            "context-request-a6-parse",
            "message-a6-context-approve",
            "attempt-a6-context-followup",
            serde_json::json!([candidate]),
            Vec::new(),
            "2026-08-15T16:00:04.000Z",
        );
        followup.purpose = "parse_draft".into();
        followup.context_source_refs = parse_constraint_source_refs("message-a6-context-user");
        let approved =
            prepare_ai_context_request_followup_in_connection(&mut connection, &followup).unwrap();
        let followup_attempt = approved
            .readback
            .call_attempts
            .iter()
            .find(|attempt| attempt.id == "attempt-a6-context-followup")
            .unwrap();
        assert_eq!(followup_attempt.purpose, "parse_draft");
        assert_eq!(
            followup_attempt.trigger_call_attempt_id.as_deref(),
            Some("attempt-a6-context-parse")
        );
        assert_eq!(
            approved.readback.context_requests[0]
                .followup_call_attempt_id
                .as_deref(),
            Some("attempt-a6-context-followup")
        );

        let batch = standard_result_batch(
            "message-a6-context-user",
            "2026-08-15T16:00:05.000Z",
        );
        let settled = settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &SettleAICallAttemptSuccessInput {
                attempt_id: "attempt-a6-context-followup".into(),
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                response_truncated: Some(false),
                usage: None,
                assistant_message: None,
                context_request: None,
                standard_result_batch: Some(batch),
                settled_at: "2026-08-15T16:00:05.000Z".into(),
            },
        )
        .unwrap();
        assert_eq!(settled.standard_results.len(), 2);
        assert!(settled
            .standard_results
            .iter()
            .all(|result| result.parse_call_attempt_id == "attempt-a6-context-followup"));
        assert_eq!(settled.projected_messages.len(), 2);
        assert_eq!(
            settled
                .messages
                .iter()
                .filter(|message| message.message_kind == "context_request_action")
                .count(),
            1
        );
        drop(connection);

        let reopened = Connection::open(&path).expect("restart-equivalent reopen");
        let readback =
            read_ai_conversation_in_connection(&reopened, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(readback.context_requests[0].state, "APPROVED");
        assert_eq!(readback.standard_results.len(), 2);
        assert_eq!(readback.call_attempts[2].purpose, "parse_draft");
        drop(reopened);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }

    #[test]
    fn a6_v57_to_v58_upgrade_preserves_a5_durable_facts_and_foreign_keys() {
        let path = temporary_database_path("a6-v57-v58-preservation");
        let mut connection = open_current_database(&path);
        let source = prepare_input(
            "attempt-a6-v57-source",
            "attempt-a6-v57-source",
            "message-a6-v57-user",
            "2026-08-15T17:00:00.000Z",
        );
        prepare_ai_call_attempt_in_connection(&mut connection, &source).unwrap();
        let candidate = identity_context_request_candidate();
        settle_ai_call_attempt_success_in_connection(
            &mut connection,
            &context_request_success_input(
                "attempt-a6-v57-source",
                "message-a6-v57-assistant",
                "context-request-a6-v57",
                serde_json::json!([{
                    "refKind":"AI_RESEARCH_OBJECT",
                    "refId":"task-2",
                    "contributionKind":"IDENTITY_METADATA"
                }]),
                serde_json::json!([candidate]),
                serde_json::json!([{
                    "refKind":"AI_RESEARCH_OBJECT",
                    "refId":"task-2",
                    "projectId":"project-1",
                    "label":"Task Two",
                    "entityType":"task",
                    "allowedContributionKinds":["IDENTITY_METADATA"]
                }]),
                "2026-08-15T17:00:01.000Z",
            ),
        )
        .unwrap();

        let current_call_attempt_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_call_attempts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let v57_call_attempt_sql = current_call_attempt_sql
            .replace(
                "purpose IN ('chat_response','action_draft_generation','parse_draft')",
                "purpose IN ('chat_response','action_draft_generation')",
            )
            .replace(
                "  CHECK (purpose != 'parse_draft' OR trigger_message_id IS NOT NULL),\n",
                "",
            );
        assert!(!v57_call_attempt_sql.contains("'parse_draft'"));
        connection
            .execute_batch(
                "PRAGMA foreign_keys=OFF;
                 DROP TABLE ai_standard_results;
                 DROP TRIGGER IF EXISTS trg_ai_call_attempt_terminal_immutable;
                 DROP INDEX IF EXISTS idx_ai_call_attempts_conversation_order;
                 DROP INDEX IF EXISTS idx_ai_call_attempts_trigger_message;
                 DROP INDEX IF EXISTS idx_ai_call_attempts_trigger_attempt;
                 PRAGMA legacy_alter_table=ON;
                 ALTER TABLE ai_call_attempts RENAME TO ai_call_attempts_v58_fixture;",
            )
            .unwrap();
        connection.execute_batch(&v57_call_attempt_sql).unwrap();
        connection
            .execute_batch(
                "INSERT INTO ai_call_attempts SELECT * FROM ai_call_attempts_v58_fixture;
                 DROP TABLE ai_call_attempts_v58_fixture;
                 PRAGMA legacy_alter_table=OFF;",
            )
            .unwrap();
        connection
            .execute_batch(AI_DURABLE_FOUNDATION_SCHEMA_SQL)
            .unwrap();
        connection
            .execute(
                "DELETE FROM schema_migrations WHERE version=?1",
                [AI_STANDARD_RESULT_SCHEMA_VERSION],
            )
            .unwrap();
        connection
            .pragma_update(None, "user_version", AI_CONTEXT_REQUEST_SCHEMA_VERSION)
            .unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        assert!(context_request_schema_is_current(&connection).unwrap());
        assert!(!standard_result_schema_is_current(&connection).unwrap());

        super::super::schema::run_migrations(&connection).expect("upgrade exact v57 fixture to v58");
        let upgraded =
            read_ai_conversation_in_connection(&connection, CURRENT_CONVERSATION_ID).unwrap();
        assert_eq!(upgraded.messages.len(), 2);
        assert_eq!(upgraded.call_attempts.len(), 1);
        assert_eq!(upgraded.call_attempts[0].id, "attempt-a6-v57-source");
        assert_eq!(upgraded.context_requests.len(), 1);
        assert_eq!(upgraded.context_requests[0].id, "context-request-a6-v57");
        assert_eq!(upgraded.context_requests[0].state, "PENDING");
        assert!(upgraded.standard_results.is_empty());
        assert!(standard_result_schema_is_current(&connection).unwrap());
        let foreign_key_errors: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_key_errors, 0);
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, AI_STANDARD_RESULT_SCHEMA_VERSION);

        drop(connection);
        std::fs::remove_dir_all(path.parent().unwrap()).expect("cleanup database");
    }
}
