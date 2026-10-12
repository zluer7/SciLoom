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
  const [saving, setSaving] = useState(false);
  const current = useRef({ baseline, draft, disabled, saving });
  current.current = { baseline, draft, disabled: disabled || identityChanged, saving };
  const alive = useRef(true);
  const identityKey = JSON.stringify(admittedIdentity);
  const dirty = () => Boolean(current.current.baseline &&
    JSON.stringify(current.current.draft) !== JSON.stringify(current.current.baseline.values));

  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    setBaseline(undefined);
    setDraft({});
    setMessage("");
    setError("");
    void readStructuredSidebar(admittedIdentity).then((snapshot) => {
      if (cancelled) return;
      setBaseline(snapshot);
      setDraft(snapshot.values);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : ui("结构化内容加载失败。"));
    });
    return () => { cancelled = true; alive.current = false; };
  }, [identityKey]);

  function discard() {
    if (current.current.saving || !current.current.baseline) return;
    current.current.draft = current.current.baseline.values;
    setDraft(current.current.draft);
    setMessage(ui("结构化草稿已取消；Raw 草稿保持。"));
    setError("");
    onDraftChange();
  }

  async function save() {
    const state = current.current;
    if (state.saving || state.disabled || !state.baseline || state.baseline.readOnly) return false;
    if (!dirty()) return true;
    current.current.saving = true;
    setSaving(true);
    setMessage("");
    setError("");
    onDraftChange();
    try {
      const snapshot = await saveStructuredSidebar(state.baseline, { ...state.draft });
      if (!alive.current) return false;
      current.current.baseline = snapshot;
      current.current.draft = snapshot.values;
      setBaseline(snapshot);
      setDraft(snapshot.values);
      setMessage(ui("结构化内容已保存并读回；Raw 文稿未改写。"));
      return true;
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : ui("结构化保存失败，草稿保留。"));
      return false;
    } finally {
      current.current.saving = false;
      if (alive.current) setSaving(false);
      onDraftChange();
    }
  }

  useImperativeHandle(ref, () => ({ isDirty: dirty, isSaving: () => current.current.saving, save, discard }));
  const readOnly = disabled || identityChanged || interactionBlocked || saving || !baseline || baseline.readOnly;
  return <div className="manuscript-structured-sidebar">
    <p>{ui("结构化内容与 Raw 文稿分别保存。")}</p>
    {getManuscriptOutlineDescriptor(admittedIdentity).fields.map((field) => <label key={field.stableKey} style={{ display: "block", marginBottom: 12 }}>
      <span>{field.displayLabel}</span>
      <textarea aria-label={field.displayLabel} disabled={readOnly} rows={3}
        style={{ display: "block", width: "100%", boxSizing: "border-box", resize: "vertical" }}
        value={draft[field.stableKey] ?? ""} onChange={(event) => {
          const next = { ...current.current.draft, [field.stableKey]: event.target.value };
          current.current.draft = next;
          setDraft(next);
          setMessage("");
          onDraftChange();
        }} />
    </label>)}
    <button type="button" disabled={readOnly || !dirty()} onClick={() => void save()}>{ui("保存结构化内容")}</button>
    <button type="button" disabled={saving || !dirty()} onClick={discard}>{ui("取消结构化草稿")}</button>
    {dirty() ? <p role="status">{ui("结构化草稿尚未保存。")}</p> : null}
    {identityChanged ? <p role="alert">{ui("结构化字段定义已变化，草稿保留且暂停保存。请取消草稿并重新打开后核对。")}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
});
