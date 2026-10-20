import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { getManuscriptOutlineDescriptor } from "../../services/manuscriptOutlineDescriptorRegistry";
import {
  readStructuredSidebar, saveStructuredSidebar,
  type StructuredSidebarIdentity, type StructuredSidebarSnapshot, type StructuredSidebarValues
} from "../../services/manuscriptStructuredSidebarService";

export interface ManuscriptStructuredSidebarHandle {
  isDirty(): boolean;
  isSaving(): boolean;
  save(): Promise<boolean>;
  discard(): void;
}

export const ManuscriptStructuredSidebar = forwardRef<ManuscriptStructuredSidebarHandle, {
  identity: StructuredSidebarIdentity;
  disabled: boolean;
  interactionBlocked?: boolean;
  onDraftChange(): void;
  ui(text: string): string;
}>(function ManuscriptStructuredSidebar({ identity, disabled, interactionBlocked, onDraftChange, ui }, ref) {
  // An external descriptor refresh must not replace a user's unsaved form.
  // Owner/channel changes mount a new keyed sidebar through the existing lifecycle.
  const [admittedIdentity] = useState(identity);
  const identityChanged = JSON.stringify(identity) !== JSON.stringify(admittedIdentity);
  const [baseline, setBaseline] = useState<StructuredSidebarSnapshot>();
  const [draft, setDraft] = useState<StructuredSidebarValues>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const firstField = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  // Once admission changes, returning to the same ID cannot revive an old request.
  const invalidated = useRef(false);
  if (identityChanged) invalidated.current = true;
  const generation = useRef(0);
  const current = useRef({ baseline, draft, disabled, saving });
  current.current = { baseline, draft, disabled: disabled || invalidated.current, saving };
  const alive = useRef(true);
  const identityKey = JSON.stringify(admittedIdentity);
  const dirty = () => Boolean(current.current.baseline &&
    JSON.stringify(current.current.draft) !== JSON.stringify(current.current.baseline.values));

  useEffect(() => {
    let cancelled = false;
    const admittedGeneration = ++generation.current;
    alive.current = true;
    setBaseline(undefined);
    setDraft({});
    setMessage("");
    setError("");
    void readStructuredSidebar(admittedIdentity).then((snapshot) => {
      if (cancelled || invalidated.current || generation.current !== admittedGeneration) return;
      setBaseline(snapshot);
      setDraft(snapshot.values);
    }).catch((reason: unknown) => {
      if (!cancelled && !invalidated.current && generation.current === admittedGeneration) {
        setError(reason instanceof Error ? reason.message : ui("结构化内容加载失败。"));
      }
    });
    return () => { cancelled = true; alive.current = false; generation.current += 1; };
  }, [identityKey]);

  useEffect(() => {
    if (editing) firstField.current?.focus();
    else if (wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  function discard() {
    if (current.current.saving || !current.current.baseline) return;
    current.current.draft = current.current.baseline.values;
    setDraft(current.current.draft);
    setEditing(false);
    setMessage(ui("结构化草稿已取消；Raw 草稿保持，已提交的内容不会撤销。"));
    // Keep any save/readback warning: cancelling a draft is not a DB rollback.
    onDraftChange();
  }

  async function save() {
    const state = current.current;
    if (state.saving || state.disabled || !state.baseline || state.baseline.readOnly) return false;
    if (!dirty()) { setEditing(false); return true; }
    const saveGeneration = generation.current;
    current.current.saving = true;
    setSaving(true);
    setMessage("");
    setError("");
    onDraftChange();
    try {
      const snapshot = await saveStructuredSidebar(state.baseline, { ...state.draft });
      if (!alive.current || invalidated.current || generation.current !== saveGeneration) return false;
      current.current.baseline = snapshot;
      current.current.draft = snapshot.values;
      setBaseline(snapshot);
      setDraft(snapshot.values);
      setEditing(false);
      setMessage(ui("结构化内容已保存并读回；Raw 文稿未改写。"));
      return true;
    } catch (reason) {
      if (alive.current && !invalidated.current && generation.current === saveGeneration) {
        setError(reason instanceof Error ? reason.message : ui("结构化保存失败，草稿保留。"));
      }
      return false;
    } finally {
      current.current.saving = false;
      if (alive.current && generation.current === saveGeneration) {
        setSaving(false);
        onDraftChange();
      }
    }
  }

  useImperativeHandle(ref, () => ({ isDirty: dirty, isSaving: () => current.current.saving, save, discard }));
  const readOnly = disabled || invalidated.current || interactionBlocked || saving || !baseline || baseline.readOnly;
  const fields = getManuscriptOutlineDescriptor(admittedIdentity).fields;
  return <div className="manuscript-structured-sidebar">
    <div className="manuscript-structured-sidebar__actions">
      {!editing && baseline && !baseline.readOnly ? <button ref={editButton} type="button" disabled={readOnly}
        onClick={() => { setEditing(true); setMessage(""); }}>{ui("编辑")}</button> : null}
      {editing ? <>
        <button type="button" disabled={readOnly || !dirty()} onClick={() => void save()}>
          {saving ? ui("正在保存…") : ui("保存结构化内容")}
        </button>
        <button type="button" disabled={saving || interactionBlocked} onClick={discard}>{ui("取消")}</button>
      </> : null}
    </div>
    {baseline ? editing ? <>
      <p className="manuscript-structured-sidebar__hint">{ui("结构化内容与 Raw 文稿分别保存。")}</p>
      {fields.map((field, index) => <label className="manuscript-structured-sidebar__field" key={field.stableKey}>
        <span>{ui(field.displayLabel)}</span>
        <textarea ref={index === 0 ? firstField : undefined} aria-label={ui(field.displayLabel)} disabled={readOnly} rows={3}
        value={draft[field.stableKey] ?? ""} onChange={(event) => {
          if (readOnly) return;
          const next = { ...current.current.draft, [field.stableKey]: event.target.value };
          current.current.draft = next;
          setDraft(next);
          setMessage("");
          onDraftChange();
        }} />
      </label>)}
    </> : <dl>
      {fields.map(field => <div key={field.stableKey}>
        <dt>{ui(field.displayLabel)}</dt>
        <dd>{baseline.values[field.stableKey] || ui("未设置")}</dd>
      </div>)}
    </dl> : !error && !invalidated.current ? <p role="status">{ui("正在加载结构化内容…")}</p> : null}
    {dirty() ? <p role="status">{ui("结构化草稿尚未保存。")}</p> : null}
    {invalidated.current ? <p role="alert">{ui("结构化字段定义已变化，草稿保留且暂停保存。请取消草稿并重新打开后核对。")}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
});
