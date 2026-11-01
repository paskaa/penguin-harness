/**
 * Company mode's workflows page: the definitions (seeded with the bidding template) up
 * top, each with its stage count and a way to start an instance for one business key, and
 * below it the instances as a swimlane — one column per stage of the picked definition,
 * each card naming its project, its business key and its attachments. Opening a card
 * shows the stage progress, the exit gates of the current stage, the event timeline, and
 * the four transitions (advance, reject, attach a ticket, note), each posting to the
 * instance's append-only stream. A skeleton until the first fetch, an error strip on
 * refetch failure, and two guided empty states (no definition, no instance).
 */
import { useCallback, useEffect, useState } from "react";
import type {
  WorkflowDefinition,
  WorkflowDefinitionItem,
  WorkflowInstanceDetail,
  WorkflowInstanceItem,
  WorkflowStage,
  WorkflowStageGate,
} from "@prismshadow/penguin-server/api";
import {
  Button,
  Input,
  Modal,
  Notice,
  Skeleton,
  Textarea,
  toastError,
  toastSuccess,
} from "@prismshadow/penguin-ui";
import * as api from "../../api/endpoints";
import { S } from "../../lib/strings";
import { apiErrorText } from "../../lib/api-error";
import { useDocumentTitle } from "../../lib/use-document-title";
import { useOrg } from "./org-layout";

const STR = () => S.workflows;

export function WorkflowsPage() {
  const { projectId, orgId } = useOrg();
  useDocumentTitle(STR().pageTitle);
  const [defs, setDefs] = useState<WorkflowDefinitionItem[] | null>(null);
  const [instances, setInstances] = useState<WorkflowInstanceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickedDef, setPickedDef] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [maintainId, setMaintainId] = useState<string | null>(null);
  const [digestOpen, setDigestOpen] = useState(false);
  const [digest, setDigest] = useState<{ date: string; markdown: string | null } | null>(null);
  const [bizKey, setBizKey] = useState("");
  const [title, setTitle] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [d, i] = await Promise.all([
        api.listOrgWorkflows(projectId, orgId),
        api.listOrgWorkflowInstances(projectId, orgId),
      ]);
      setDefs(d.definitions);
      setInstances(i.instances);
      setError(null);
      if (d.definitions.length > 0 && pickedDef === null) {
        const bidding = d.definitions.find((x) => x.id === "bidding-v1") ?? d.definitions[0];
        if (bidding) setPickedDef(bidding.id);
      }
    } catch (err) {
      setError(apiErrorText(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, orgId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const [detail, setDetail] = useState<WorkflowInstanceDetail | null>(null);
  useEffect(() => {
    if (openId === null) {
      setDetail(null);
      return;
    }
    api
      .getOrgWorkflowInstance(projectId, orgId, openId)
      .then(setDetail)
      .catch((err: unknown) => toastError(apiErrorText(err)));
  }, [projectId, orgId, openId]);

  const mutate = async (fn: () => Promise<WorkflowInstanceDetail>, ok: string) => {
    try {
      const next = await fn();
      setDetail(next);
      await refresh();
      toastSuccess(ok);
    } catch (err) {
      toastError(apiErrorText(err));
    }
  };

  if (defs === null || instances === null) {
    return (
      <div className="flex flex-col gap-3 p-6" aria-label={STR().pageTitle}>
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    );
  }

  const stages = detail?.definition?.stages ?? [];
  const shown = pickedDef ? instances.filter((i) => i.definitionId === pickedDef) : instances;
  const byStage = new Map<string, WorkflowInstanceItem[]>();
  for (const i of shown) {
    const list = byStage.get(i.currentStage) ?? [];
    list.push(i);
    byStage.set(i.currentStage, list);
  }

  return (
    <div className="flex min-h-full flex-col gap-6 p-6" aria-label={STR().pageTitle}>
      {error && <Notice tone="danger">{error}</Notice>}

      <section aria-label={STR().definitions}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{STR().definitions}</h2>
          <Button onClick={() => setCreating(true)} disabled={defs.length === 0}>
            {STR().startInstance}
          </Button>
        </div>
        {defs.length === 0 ? (
          <Notice tone="info">{STR().noDefinitions}</Notice>
        ) : (
          <div className="flex flex-wrap gap-3">
            {defs.map((d) => (
              <div
                key={d.id}
                className={`min-w-56 flex-1 rounded-lg border ${
                  pickedDef === d.id ? "border-blue-500" : "border-gray-200 dark:border-gray-700"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setPickedDef(d.id)}
                  aria-pressed={pickedDef === d.id}
                  className="block w-full p-4 text-left"
                >
                  <div className="font-medium">{d.name}</div>
                  <div className="mt-1 text-sm text-gray-500">
                    {STR().version(d.version)} · {STR().stageCount(d.stageCount)} ·{" "}
                    {STR().instanceCount(d.instanceCount)}
                  </div>
                  {d.description && <div className="mt-1 text-sm">{d.description}</div>}
                  {d.invalid && <Notice tone="danger">{d.invalid}</Notice>}
                </button>
                <div className="flex items-center justify-between px-4 pb-3">
                  <span className="text-xs text-gray-500">
                    {d.historyVersions.length > 0
                      ? STR().history(d.historyVersions.map((v) => `v${v}`).join(" · "))
                      : ""}
                  </span>
                  <Button variant="ghost" onClick={() => setMaintainId(d.id)}>
                    {STR().maintain}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-label={STR().instances} className="flex flex-col gap-3">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{STR().instances}</h2>
          <Button variant="ghost" onClick={() => setDigestOpen(true)}>
            {STR().dailyDigest}
          </Button>
        </div>
        {shown.length === 0 ? (
          <Notice tone="info">{STR().noInstances}</Notice>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {[...byStage.entries()].map(([stage, list]) => (
              <div key={stage} className="min-w-64 flex-1 rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
                <div className="mb-2 text-sm font-medium">
                  {stage} · {list.length}
                </div>
                <div className="flex flex-col gap-2">
                  {list.map((i) => (
                    <button
                      key={i.instanceId}
                      type="button"
                      onClick={() => setOpenId(i.instanceId)}
                      className="rounded-md border border-gray-200 bg-white p-3 text-left dark:border-gray-700 dark:bg-gray-800"
                    >
                      <div className="font-medium">{i.title}</div>
                      <div className="mt-0.5 text-xs text-gray-500">
                        {i.bizKey} · {i.definitionName}
                      </div>
                      {i.attachments.length > 0 && (
                        <div className="mt-1 text-xs text-gray-500">
                          {STR().attached(i.attachments.length)}
                        </div>
                      )}
                      {i.snapshotStale && (
                        <div className="mt-1 text-xs text-amber-600">{STR().stale}</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {creating && (
        <CreateInstanceModal
          projectId={projectId}
          orgId={orgId}
          definitions={defs}
          pickedDef={pickedDef}
          bizKey={bizKey}
          setBizKey={setBizKey}
          title={title}
          setTitle={setTitle}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            setBizKey("");
            setTitle("");
            await refresh();
          }}
        />
      )}

      {maintainId !== null && (
        <MaintainDialog
          projectId={projectId}
          orgId={orgId}
          def={defs.find((d) => d.id === maintainId) ?? null}
          onClose={() => setMaintainId(null)}
          onSaved={async () => {
            setMaintainId(null);
            await refresh();
          }}
        />
      )}

      {digestOpen && (
        <Modal
          open
          onClose={() => {
            setDigestOpen(false);
            setDigest(null);
          }}
          title={S.workflows.dailyDigest}
        >
          <DigestView
            projectId={projectId}
            orgId={orgId}
            digest={digest}
            setDigest={setDigest}
          />
        </Modal>
      )}

      {openId !== null && (
        <InstanceDialog
          detail={detail}
          projectId={projectId}
          orgId={orgId}
          stages={stages.map((s) => ({ key: s.key, name: s.name }))}
          onClose={() => setOpenId(null)}
          onAdvance={(skip) =>
            mutate(
              () => api.advanceOrgWorkflowInstance(projectId, orgId, openId, skip ? { skip } : {}),
              STR().advanced,
            )
          }
          onReject={(to, reason) =>
            mutate(
              () =>
                api.rejectOrgWorkflowInstance(projectId, orgId, openId, {
                  ...(to ? { to } : {}),
                  reason,
                }),
              STR().rejected,
            )
          }
          onAttach={(ticketId) =>
            mutate(
              () => api.attachOrgWorkflowTicket(projectId, orgId, openId, { ticketId }),
              STR().attachedOne,
            )
          }
          onApprove={(comment, force) =>
            mutate(
              () =>
                api.approveOrgWorkflowInstance(
                  projectId,
                  orgId,
                  openId,
                  { ...(comment ? { comment } : {}), ...(force === true ? { force: true } : {}) },
                ),
              STR().approved,
            )
          }
          onNote={(text) =>
            mutate(() => api.noteOrgWorkflowInstance(projectId, orgId, openId, { text }), STR().noted)
          }
        />
      )}
    </div>
  );
}

function CreateInstanceModal(props: {
  projectId: string;
  orgId: string;
  definitions: WorkflowDefinitionItem[];
  pickedDef: string | null;
  bizKey: string;
  setBizKey: (v: string) => void;
  title: string;
  setTitle: (v: string) => void;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [defId, setDefId] = useState(props.pickedDef ?? props.definitions[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const valid = defId !== "" && props.bizKey.trim() !== "" && props.title.trim() !== "";
  return (
    <Modal open onClose={props.onClose} title={S.workflows.startInstance}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {S.workflows.definition}
          <select
            value={defId}
            onChange={(e) => setDefId(e.target.value)}
            className="rounded-md border border-gray-300 p-2 dark:border-gray-600 dark:bg-gray-800"
          >
            {props.definitions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} (v{d.version})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {S.workflows.bizKey}
          <Input
            value={props.bizKey}
            onChange={(e) => props.setBizKey(e.target.value)}
            placeholder="term-1247"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {S.workflows.title}
          <Input
            value={props.title}
            onChange={(e) => props.setTitle(e.target.value)}
            placeholder={S.workflows.titleHint}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>
            {S.workflows.cancel}
          </Button>
          <Button
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.createOrgWorkflowInstance(props.projectId, props.orgId, {
                  definitionId: defId,
                  bizKey: props.bizKey.trim(),
                  title: props.title.trim(),
                });
                toastSuccess(S.workflows.created);
                await props.onCreated();
              } catch (err) {
                toastError(apiErrorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {S.workflows.create}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function MaintainDialog(props: {
  projectId: string;
  orgId: string;
  def: WorkflowDefinitionItem | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [doc, setDoc] = useState<WorkflowDefinition | null>(null);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (props.def === null) return;
    api
      .getOrgWorkflow(props.projectId, props.orgId, props.def.id)
      .then((d) => {
        setDoc({ ...d, version: d.version + 1 });
        setSel(0);
      })
      .catch((err: unknown) => setError(apiErrorText(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.def?.id]);
  const patch = (fn: (d: WorkflowDefinition) => WorkflowDefinition) =>
    setDoc((d) => (d === null ? d : fn({ ...d, stages: d.stages.map((s) => ({ ...s })) })));
  const stage = doc?.stages[sel] ?? null;
  const patchStage = (fn: (s: WorkflowStage) => WorkflowStage) =>
    patch((d) => {
      const stages = [...d.stages];
      const cur = stages[sel];
      if (cur) stages[sel] = fn({ ...cur });
      return { ...d, stages };
    });
  const moveStage = (delta: -1 | 1) => {
    if (!doc) return;
    const j = sel + delta;
    if (j < 0 || j >= doc.stages.length) return;
    const cur = doc.stages[sel];
    if (!cur) return;
    patch((d) => {
      const stages = [...d.stages];
      stages.splice(sel, 1);
      stages.splice(j, 0, cur);
      return { ...d, stages };
    });
    setSel(j);
  };
  return (
    <Modal
      open
      onClose={props.onClose}
      title={S.workflows.maintainTitle(props.def?.name ?? "")}
      widthClass="sm:max-w-4xl"
    >
      <div className="flex flex-col gap-3">
        {props.def && props.def.historyVersions.length > 0 && (
          <div className="text-sm text-gray-500">
            {S.workflows.history(props.def.historyVersions.map((v) => `v${v}`).join(" · "))}
          </div>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {doc === null && error === null ? (
          <Skeleton />
        ) : doc === null ? null : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-sm">
                {S.workflows.defName}
                <Input value={doc.name} onChange={(e) => patch((d) => ({ ...d, name: e.target.value }))} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {S.workflows.versionLabel}
                <Input
                  value={String(doc.version)}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isInteger(v)) patch((d) => ({ ...d, version: v }));
                  }}
                />
              </label>
              <label className="col-span-2 flex flex-col gap-1 text-sm">
                {S.workflows.descLabel}
                <Input
                  value={doc.description}
                  onChange={(e) => patch((d) => ({ ...d, description: e.target.value }))}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                {S.workflows.bizPrefixLabel}
                <Input
                  value={doc.bizKeyPrefix}
                  onChange={(e) => patch((d) => ({ ...d, bizKeyPrefix: e.target.value }))}
                />
              </label>
              <div className="flex items-end">
                <Button
                  variant="ghost"
                  onClick={() => {
                    patch((d) => ({
                      ...d,
                      stages: [
                        ...d.stages,
                        { key: `stage${d.stages.length + 1}`, name: S.workflows.newStage, ownerRole: "", entries: [], exits: [] },
                      ],
                    }));
                    setSel(doc.stages.length);
                  }}
                >
                  {S.workflows.addStage}
                </Button>
              </div>
            </div>
            <div className="flex gap-3">
              <ol className="flex w-56 shrink-0 flex-col gap-1" aria-label={S.workflows.stageChain}>
                {doc.stages.map((s, i) => (
                  <li key={`${s.key}-${i}`}>
                    <button
                      type="button"
                      onClick={() => setSel(i)}
                      aria-pressed={sel === i}
                      className={`flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm ${
                        sel === i ? "border-blue-500" : "border-gray-200 dark:border-gray-700"
                      }`}
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs dark:bg-gray-700">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{s.name || s.key}</span>
                        <span className="block truncate text-xs text-gray-500">
                          {s.key}
                          {s.ownerRole ? ` · ${s.ownerRole}` : ""}
                          {(s.parallelWith?.length ?? 0) > 0 ? ` · ${S.workflows.parallelMark}` : ""}
                          {s.skipWhen ? ` · ${S.workflows.skipMark}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {stage === null ? (
                  <Notice tone="info">{S.workflows.noStages}</Notice>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex flex-col gap-1 text-sm">
                        {S.workflows.stageKey}
                        <Input value={stage.key} onChange={(e) => patchStage((s) => ({ ...s, key: e.target.value }))} />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        {S.workflows.stageName}
                        <Input value={stage.name} onChange={(e) => patchStage((s) => ({ ...s, name: e.target.value }))} />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        {S.workflows.ownerRole}
                        <Input
                          value={stage.ownerRole}
                          onChange={(e) => patchStage((s) => ({ ...s, ownerRole: e.target.value }))}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        {S.workflows.skipWhen}
                        <Input
                          value={stage.skipWhen ?? ""}
                          placeholder={S.workflows.skipWhenHint}
                          onChange={(e) =>
                            patchStage((s) => ({
                              ...s,
                              ...(e.target.value.trim() === "" ? { skipWhen: undefined } : { skipWhen: e.target.value.trim() }),
                            }))
                          }
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-gray-500">{S.workflows.parallelWith}</span>
                      {doc.stages
                        .filter((_, i) => i !== sel)
                        .map((s) => (
                          <label key={s.key} className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={(stage.parallelWith ?? []).includes(s.key)}
                              onChange={(e) =>
                                patchStage((cur) => ({
                                  ...cur,
                                  parallelWith: e.target.checked
                                    ? [...(cur.parallelWith ?? []), s.key]
                                    : (cur.parallelWith ?? []).filter((k) => k !== s.key),
                                }))
                              }
                            />
                            {s.name || s.key}
                          </label>
                        ))}
                    </div>
                    <GateEditor
                      title={S.workflows.entries}
                      gates={stage.entries}
                      onChange={(entries) => patchStage((s) => ({ ...s, entries }))}
                    />
                    <GateEditor
                      title={S.workflows.exits}
                      gates={stage.exits}
                      onChange={(exits) => patchStage((s) => ({ ...s, exits }))}
                    />
                    <div className="flex gap-2">
                      <Button variant="ghost" disabled={sel === 0} onClick={() => moveStage(-1)}>
                        {S.workflows.moveUp}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={sel >= doc.stages.length - 1}
                        onClick={() => moveStage(1)}
                      >
                        {S.workflows.moveDown}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          patch((d) => ({ ...d, stages: d.stages.filter((_, i) => i !== sel) }));
                          setSel(Math.max(0, sel - 1));
                        }}
                      >
                        {S.workflows.deleteStage}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={props.onClose}>
                {S.workflows.cancel}
              </Button>
              <Button
                disabled={doc === null || busy}
                onClick={async () => {
                  if (!doc) return;
                  setBusy(true);
                  setError(null);
                  try {
                    const saved = await api.putOrgWorkflowDefinition(props.projectId, props.orgId, doc.id, {
                      definition: doc,
                    });
                    toastSuccess(S.workflows.upgraded(saved.version));
                    await props.onSaved();
                  } catch (err) {
                    setError(apiErrorText(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {S.workflows.saveVersion}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function GateEditor(props: {
  title: string;
  gates: WorkflowStageGate[];
  onChange: (gates: WorkflowStageGate[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-gray-200 p-2 dark:border-gray-700">
      <div className="flex items-center justify-between text-sm font-medium">
        <span>{props.title}</span>
        <Button variant="ghost" onClick={() => props.onChange([...props.gates, { text: "" }])}>
          {S.workflows.addGate}
        </Button>
      </div>
      {props.gates.length === 0 && (
        <div className="text-xs text-gray-500">{S.workflows.noGates}</div>
      )}
      {props.gates.map((g, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-1">
          <Input
            value={g.text}
            placeholder={S.workflows.gateTextHint}
            onChange={(e) =>
              props.onChange(props.gates.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
            }
          />
          <Input
            value={g.link ?? ""}
            placeholder={S.workflows.gateLinkHint}
            onChange={(e) =>
              props.onChange(
                props.gates.map((x, j) =>
                  j === i
                    ? { ...x, ...(e.target.value.trim() === "" ? { link: undefined } : { link: e.target.value.trim() }) }
                    : x,
                ),
              )
            }
          />
          <Input
            value={g.ticketPrefix ?? ""}
            placeholder={S.workflows.gatePrefixHint}
            onChange={(e) =>
              props.onChange(
                props.gates.map((x, j) =>
                  j === i
                    ? { ...x, ...(e.target.value.trim() === "" ? { ticketPrefix: undefined } : { ticketPrefix: e.target.value.trim() }) }
                    : x,
                ),
              )
            }
          />
          <Button
            variant="ghost"
            aria-label={S.workflows.deleteGate}
            onClick={() => props.onChange(props.gates.filter((_, j) => j !== i))}
          >
            ✕
          </Button>
        </div>
      ))}
    </div>
  );
}

function DigestView(props: {
  projectId: string;
  orgId: string;
  digest: { date: string; markdown: string | null } | null;
  setDigest: (d: { date: string; markdown: string | null } | null) => void;
}) {
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async (day: string | undefined) => {
    setBusy(true);
    try {
      props.setDigest(await api.getOrgWorkflowDigest(props.projectId, props.orgId, day));
    } catch (err) {
      toastError(apiErrorText(err));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (props.digest === null) void load(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          value={date}
          onChange={(e) => setDate(e.target.value)}
          placeholder="2026-11-02"
        />
        <Button variant="ghost" disabled={busy} onClick={() => load(date.trim() || undefined)}>
          {S.workflows.loadDigest}
        </Button>
      </div>
      {props.digest === null ? (
        <Skeleton />
      ) : props.digest.markdown === null ? (
        <Notice tone="info">{S.workflows.noActivity(props.digest.date)}</Notice>
      ) : (
        <pre className="whitespace-pre-wrap text-sm">{props.digest.markdown}</pre>
      )}
    </div>
  );
}

/** Skippable stages the backend accepts from here: the current one and the next one. */
function skippableNext(d: WorkflowInstanceDetail): WorkflowStage[] {
  const stages = d.definition?.stages ?? [];
  const idx = stages.findIndex((s) => s.key === d.currentStage);
  if (idx < 0) return [];
  return [stages[idx], stages[idx + 1]].filter((s): s is WorkflowStage => !!s?.skipWhen);
}

function InstanceDialog(props: {
  detail: WorkflowInstanceDetail | null;
  projectId: string;
  orgId: string;
  stages: Array<{ key: string; name: string }>;
  onClose: () => void;
  onAdvance: (skip?: string) => Promise<void>;
  onReject: (to: string | undefined, reason: string) => Promise<void>;
  onAttach: (ticketId: string) => Promise<void>;
  onApprove: (comment: string, force?: boolean) => Promise<void>;
  onNote: (text: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [rejectTo, setRejectTo] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [comment, setComment] = useState("");
  const [auditing, setAuditing] = useState(false);
  const [note, setNote] = useState("");
  const d = props.detail;
  const approvals = (d?.events ?? []).filter((e) => e.kind === "approved");
  const stageName = (key: string): string =>
    props.stages.find((s) => s.key === key)?.name ?? key;
  return (
    <Modal open onClose={props.onClose} title={d ? d.title : S.workflows.loading}>
      {!d ? (
        <Skeleton />
      ) : (
        <div className="flex flex-col gap-4">
          {d.versionMismatch && (
            <Notice tone="attention">
              {S.workflows.versionMismatch(d.definitionVersion, d.definition?.version ?? d.definitionVersion)}
            </Notice>
          )}
          <div className="flex justify-end">
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  const exp = await api.exportOrgWorkflowInstance(
                    props.projectId,
                    props.orgId,
                    d.instanceId,
                  );
                  const blob = new Blob([exp.markdown], { type: "text/markdown;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = exp.filename;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch (err) {
                  toastError(apiErrorText(err));
                }
              }}
            >
              {S.workflows.exportMd}
            </Button>
          </div>
          <ol className="flex flex-wrap gap-1" aria-label={S.workflows.progress}>
            {props.stages.map((s) => {
              const state = d.stepStates[s.key] ?? "pending";
              return (
                <li
                  key={s.key}
                  title={s.name}
                  aria-current={d.currentStage === s.key ? "step" : undefined}
                  className={`rounded px-2 py-1 text-xs ${
                    state === "done"
                      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                      : d.currentStage === s.key
                        ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                        : "bg-gray-100 text-gray-500 dark:bg-gray-800"
                  }`}
                >
                  {s.name}
                </li>
              );
            })}
          </ol>

          {d.definition && (
            <StageGates
              definition={d.definition}
              currentStage={d.currentStage}
              bizKey={d.bizKey}
            />
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => props.onAdvance()}>{S.workflows.advance}</Button>
            {skippableNext(d).map((s) => (
              <Button
                key={s.key}
                variant="ghost"
                onClick={() => props.onAdvance(s.key)}
                title={S.workflows.skipHint(s.name)}
              >
                {S.workflows.skip(s.name)}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <div className="text-sm font-medium">{S.workflows.audit}</div>
            <div className="flex gap-2">
              <Input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={S.workflows.commentHint}
              />
              <Button
                disabled={auditing}
                onClick={async () => {
                  setAuditing(true);
                  try {
                    await props.onApprove(comment.trim());
                    setComment("");
                  } finally {
                    setAuditing(false);
                  }
                }}
              >
                {auditing ? S.workflows.aiAuditing : S.workflows.aiApprove}
              </Button>
              <Button
                variant="ghost"
                disabled={comment.trim() === ""}
                title={S.workflows.forceHint}
                onClick={() => {
                  props.onApprove(comment.trim(), true);
                  setComment("");
                }}
              >
                {S.workflows.forceApprove}
              </Button>
            </div>
            {approvals.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm text-gray-500">
                {approvals.map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    ✅ {stageName(e.stage ?? "")} · {e.by} · {e.at.slice(0, 16).replace("T", " ")}
                    {e.reason ? ` · ${e.reason}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <div className="text-sm font-medium">{S.workflows.reject}</div>
            <div className="flex gap-2">
              <Input
                value={rejectTo}
                onChange={(e) => setRejectTo(e.target.value)}
                placeholder={S.workflows.rejectToHint}
              />
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={S.workflows.reasonHint}
              />
              <Button
                variant="ghost"
                disabled={reason.trim() === ""}
                onClick={() => props.onReject(rejectTo.trim() || undefined, reason.trim())}
              >
                {S.workflows.reject}
              </Button>
            </div>
          </div>

          <div className="flex gap-2">
            <Input
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
              placeholder={S.workflows.attachHint}
            />
            <Button
              variant="ghost"
              disabled={ticketId.trim() === ""}
              onClick={() => props.onAttach(ticketId.trim())}
            >
              {S.workflows.attach}
            </Button>
          </div>
          {d.attachments.length > 0 && (
            <div className="text-sm text-gray-500">{d.attachments.join(" · ")}</div>
          )}

          <div className="flex flex-col gap-2">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={S.workflows.noteHint} />
            <div>
              <Button
                variant="ghost"
                disabled={note.trim() === ""}
                onClick={() => {
                  props.onNote(note.trim());
                  setNote("");
                }}
              >
                {S.workflows.addNote}
              </Button>
            </div>
          </div>

          <ol className="flex flex-col gap-1" aria-label={S.workflows.timeline}>
            {[...d.events].reverse().map((e, i) => (
              <li key={`${e.at}-${i}`} className="text-sm">
                <span className="text-gray-500">{e.at.slice(0, 16).replace("T", " ")}</span>{" "}
                <span className="font-medium">{e.kind}</span> {e.by}
                {e.from || e.to ? ` · ${e.from ?? ""} → ${e.to ?? ""}` : ""}
                {e.ticketId ? ` · ${e.ticketId}` : ""}
                {e.reason ? ` · ${e.reason}` : ""}
                {e.text ? ` · ${e.text}` : ""}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Modal>
  );
}

function StageGates(props: {
  definition: NonNullable<WorkflowInstanceDetail["definition"]>;
  currentStage: string;
  bizKey: string;
}) {
  const stage = props.definition.stages.find((s) => s.key === props.currentStage);
  if (!stage || stage.exits.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <div className="text-sm font-medium">
        {S.workflows.exitGates(stage.name)}
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {stage.exits.map((g, i) => (
          <li key={i}>
            ✅ {g.text}
            {g.link && (
              <>
                {" "}
                <a
                  className="text-blue-600 underline"
                  href={g.link.replace("{bizKey}", encodeURIComponent(props.bizKey))}
                  target="_blank"
                  rel="noreferrer"
                >
                  {S.workflows.goFulfill}
                </a>
              </>
            )}
            {g.ticketPrefix && <span className="text-gray-500"> · {g.ticketPrefix}*</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
