use serde::Deserialize;
use std::collections::HashSet;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FormalSwitchOperationState {
    pub(crate) phase: String,
    pub(crate) settlement_outcome: String,
    pub(crate) db_outcome: String,
    pub(crate) activation_outcome: String,
    pub(crate) terminal_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatrixPhase {
    name: String,
    terminal: bool,
    occupies_unresolved_slot: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatrixTransition {
    from: String,
    to: String,
    settlement: Vec<String>,
    db: Vec<String>,
    activation: Vec<String>,
    terminal_code: Option<String>,
    effect_permission: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutcomeMutationPhases {
    settlement_outcome: Vec<String>,
    db_outcome: Vec<String>,
    activation_outcome: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FormalSwitchRecoveryStateMatrixV1 {
    matrix_id: String,
    matrix_version: u64,
    initial: MatrixState,
    terminal_codes: Vec<String>,
    slot_releasing_terminal_codes: Vec<String>,
    phases: Vec<MatrixPhase>,
    settlement_outcomes: Vec<String>,
    db_outcomes: Vec<String>,
    activation_outcomes: Vec<String>,
    outcome_mutation_phases: OutcomeMutationPhases,
    transitions: Vec<MatrixTransition>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatrixState {
    phase: String,
    settlement_outcome: String,
    db_outcome: String,
    activation_outcome: String,
    terminal_code: Option<String>,
}

static MATRIX: OnceLock<Result<FormalSwitchRecoveryStateMatrixV1, String>> = OnceLock::new();

fn load_matrix() -> Result<&'static FormalSwitchRecoveryStateMatrixV1, String> {
    MATRIX
        .get_or_init(|| {
            let matrix: FormalSwitchRecoveryStateMatrixV1 = serde_json::from_str(include_str!(
                "../../../../src/contracts/formalSwitchRecoveryStateMatrixV1.json"
            ))
            .map_err(|error| format!("FORMAL_SWITCH_STATE_MATRIX_INVALID_JSON:{error}"))?;
            validate_matrix(&matrix)?;
            Ok(matrix)
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn validate_matrix(matrix: &FormalSwitchRecoveryStateMatrixV1) -> Result<(), String> {
    if matrix.matrix_id != "FormalSwitchRecoveryStateMatrixV1"
        || matrix.matrix_version != 1
        || matrix.transitions.is_empty()
    {
        return Err("FORMAL_SWITCH_STATE_MATRIX_IDENTITY_INVALID".into());
    }
    let phases = matrix
        .phases
        .iter()
        .map(|phase| phase.name.as_str())
        .collect::<HashSet<_>>();
    let expected_phases = [
        "prepared",
        "settlement_started",
        "settlement_complete",
        "db_pending",
        "db_complete",
        "activation_pending",
        "contained",
        "blocked",
        "resolved",
        "cancelled_safe",
    ];
    if phases.len() != matrix.phases.len()
        || matrix
            .phases
            .iter()
            .map(|phase| phase.name.as_str())
            .collect::<Vec<_>>()
            != expected_phases
        || !phases.contains(matrix.initial.phase.as_str())
        || matrix.transitions.iter().any(|transition| {
            !phases.contains(transition.from.as_str())
                || !phases.contains(transition.to.as_str())
                || transition.effect_permission.is_empty()
        })
    {
        return Err("FORMAL_SWITCH_STATE_MATRIX_PHASE_INVALID".into());
    }
    let terminals = matrix
        .terminal_codes
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if terminals.len() != matrix.terminal_codes.len()
        || matrix
            .slot_releasing_terminal_codes
            .iter()
            .any(|value| !terminals.contains(value.as_str()))
        || matrix.slot_releasing_terminal_codes != ["RESOLVED", "CANCELLED_SAFE"]
    {
        return Err("FORMAL_SWITCH_STATE_MATRIX_TERMINAL_INVALID".into());
    }
    if !matrix
        .settlement_outcomes
        .contains(&matrix.initial.settlement_outcome)
        || !matrix.db_outcomes.contains(&matrix.initial.db_outcome)
        || !matrix
            .activation_outcomes
            .contains(&matrix.initial.activation_outcome)
    {
        return Err("FORMAL_SWITCH_STATE_MATRIX_INITIAL_INVALID".into());
    }
    for phase in &matrix.phases {
        let terminal_code_expected = match phase.name.as_str() {
            "contained" | "blocked" | "resolved" | "cancelled_safe" => true,
            _ => false,
        };
        let expected_slot = !matches!(phase.name.as_str(), "resolved" | "cancelled_safe");
        if phase.terminal != terminal_code_expected
            || phase.occupies_unresolved_slot != expected_slot
        {
            return Err("FORMAL_SWITCH_STATE_MATRIX_TERMINAL_PHASE_INVALID".into());
        }
    }
    if matrix.outcome_mutation_phases.settlement_outcome != ["prepared", "settlement_started"]
        || matrix.outcome_mutation_phases.db_outcome != ["db_pending"]
        || matrix.outcome_mutation_phases.activation_outcome != ["activation_pending"]
    {
        return Err("FORMAL_SWITCH_STATE_MATRIX_MUTATION_AUTHORITY_INVALID".into());
    }
    let mut transition_identities = HashSet::new();
    for transition in &matrix.transitions {
        if !transition_identities.insert((transition.from.as_str(), transition.to.as_str()))
            || transition.settlement.is_empty()
            || transition.db.is_empty()
            || transition.activation.is_empty()
            || transition
                .settlement
                .iter()
                .any(|value| !matrix.settlement_outcomes.contains(value))
            || transition
                .db
                .iter()
                .any(|value| !matrix.db_outcomes.contains(value))
            || transition
                .activation
                .iter()
                .any(|value| !matrix.activation_outcomes.contains(value))
            || transition
                .terminal_code
                .as_ref()
                .is_some_and(|value| !terminals.contains(value.as_str()))
        {
            return Err("FORMAL_SWITCH_STATE_MATRIX_TRANSITION_INVALID".into());
        }
    }
    Ok(())
}

pub(crate) fn initial_state() -> Result<FormalSwitchOperationState, String> {
    let initial = &load_matrix()?.initial;
    Ok(FormalSwitchOperationState {
        phase: initial.phase.clone(),
        settlement_outcome: initial.settlement_outcome.clone(),
        db_outcome: initial.db_outcome.clone(),
        activation_outcome: initial.activation_outcome.clone(),
        terminal_code: initial.terminal_code.clone(),
    })
}

fn transition_matches_state(
    transition: &MatrixTransition,
    state: &FormalSwitchOperationState,
) -> bool {
    transition.to == state.phase
        && transition.settlement.contains(&state.settlement_outcome)
        && transition.db.contains(&state.db_outcome)
        && transition.activation.contains(&state.activation_outcome)
        && transition.terminal_code == state.terminal_code
}

pub(crate) fn validate_state(state: &FormalSwitchOperationState) -> Result<(), String> {
    let matrix = load_matrix()?;
    let initial = &matrix.initial;
    let initial_match = state.phase == initial.phase
        && state.settlement_outcome == initial.settlement_outcome
        && state.db_outcome == initial.db_outcome
        && state.activation_outcome == initial.activation_outcome
        && state.terminal_code == initial.terminal_code;
    if initial_match
        || matrix
            .transitions
            .iter()
            .any(|transition| transition_matches_state(transition, state))
    {
        Ok(())
    } else {
        Err("INVALID_TRANSITION_STATE".into())
    }
}

pub(crate) fn validate_transition(
    current: &FormalSwitchOperationState,
    next: &FormalSwitchOperationState,
) -> Result<(), String> {
    validate_state(current)?;
    validate_state(next)?;
    let matrix = load_matrix()?;
    let transition = matrix
        .transitions
        .iter()
        .find(|transition| {
            transition.from == current.phase && transition_matches_state(transition, next)
        })
        .ok_or("INVALID_TRANSITION")?;
    let mutation = &matrix.outcome_mutation_phases;
    if !mutation.settlement_outcome.contains(&transition.from)
        && next.settlement_outcome != current.settlement_outcome
    {
        return Err("INVALID_SETTLEMENT_OUTCOME_DELTA".into());
    }
    if !mutation.db_outcome.contains(&transition.from) && next.db_outcome != current.db_outcome {
        return Err("INVALID_DB_OUTCOME_DELTA".into());
    }
    if !mutation.activation_outcome.contains(&transition.from)
        && next.activation_outcome != current.activation_outcome
    {
        return Err("INVALID_ACTIVATION_OUTCOME_DELTA".into());
    }
    Ok(())
}

fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn in_list(values: &[String]) -> String {
    values
        .iter()
        .map(|value| quoted(value))
        .collect::<Vec<_>>()
        .join(",")
}

fn terminal_sql(column: &str, value: &Option<String>) -> String {
    value.as_ref().map_or_else(
        || format!("{column} IS NULL"),
        |value| format!("{column}={}", quoted(value)),
    )
}

fn state_sql(prefix: &str, transition: &MatrixTransition) -> String {
    format!(
        "({p}phase={phase} AND {p}settlement_outcome IN ({settlement}) AND {p}db_outcome IN ({db}) AND {p}activation_outcome IN ({activation}) AND {terminal})",
        p = prefix,
        phase = quoted(&transition.to),
        settlement = in_list(&transition.settlement),
        db = in_list(&transition.db),
        activation = in_list(&transition.activation),
        terminal = terminal_sql(&format!("{prefix}terminal_code"), &transition.terminal_code),
    )
}

pub(crate) fn valid_state_sql(prefix: &str) -> Result<String, String> {
    let matrix = load_matrix()?;
    let initial = &matrix.initial;
    let mut clauses = vec![format!(
        "({p}phase={phase} AND {p}settlement_outcome={settlement} AND {p}db_outcome={db} AND {p}activation_outcome={activation} AND {terminal})",
        p = prefix,
        phase = quoted(&initial.phase),
        settlement = quoted(&initial.settlement_outcome),
        db = quoted(&initial.db_outcome),
        activation = quoted(&initial.activation_outcome),
        terminal = terminal_sql(&format!("{prefix}terminal_code"), &initial.terminal_code),
    )];
    clauses.extend(
        matrix
            .transitions
            .iter()
            .map(|transition| state_sql(prefix, transition)),
    );
    Ok(format!("({})", clauses.join(" OR ")))
}

pub(crate) fn valid_transition_sql() -> Result<String, String> {
    let matrix = load_matrix()?;
    let mutation = &matrix.outcome_mutation_phases;
    let clauses = matrix
        .transitions
        .iter()
        .map(|transition| {
            let mut terms = vec![
                format!("OLD.phase={}", quoted(&transition.from)),
                state_sql("NEW.", transition),
            ];
            if !mutation.settlement_outcome.contains(&transition.from) {
                terms.push("NEW.settlement_outcome=OLD.settlement_outcome".into());
            }
            if !mutation.db_outcome.contains(&transition.from) {
                terms.push("NEW.db_outcome=OLD.db_outcome".into());
            }
            if !mutation.activation_outcome.contains(&transition.from) {
                terms.push("NEW.activation_outcome=OLD.activation_outcome".into());
            }
            format!("({})", terms.join(" AND "))
        })
        .collect::<Vec<_>>();
    Ok(format!("({})", clauses.join(" OR ")))
}

pub(crate) fn unresolved_slot_predicate_sql() -> Result<String, String> {
    let matrix = load_matrix()?;
    Ok(format!(
        "(terminal_code IS NULL OR terminal_code NOT IN ({}))",
        in_list(&matrix.slot_releasing_terminal_codes)
    ))
}

pub(crate) fn occupies_unresolved_slot(state: &FormalSwitchOperationState) -> Result<bool, String> {
    validate_state(state)?;
    let matrix = load_matrix()?;
    Ok(!state
        .terminal_code
        .as_ref()
        .is_some_and(|code| matrix.slot_releasing_terminal_codes.contains(code)))
}

pub(crate) fn validate_normative_matrix() -> Result<(), String> {
    load_matrix().map(|_| ())
}
