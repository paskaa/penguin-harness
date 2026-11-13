/**
 * The DeepSeek Harness plugin market, as a page of its own.
 *
 * A dsh "market" is one static JSON file an operator adds here (format 1 — see the server's
 * `plugin/dsh-market.ts`). Its plugins are Cordis plugins that run inside the dsh host, which this
 * server does not have, so the page never promises a straight install: the button says **convert
 * and install**, and the dialog after it lists exactly what the server carried (skills, MCP
 * servers) and what it had to leave behind (the host code). The server refuses a package with
 * nothing to carry, and the reason is shown as it came.
 *
 * The listing is the whole market at once — the community index is 5 437 plugins — so the page
 * filters locally and renders a slice at a time; there is no per-keystroke request.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DshEntryItem,
  DshMarketInstallResponse,
  DshMarketResponse,
} from "@prismshadow/penguin-server/api";
import {
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Modal,
  Notice,
  PageFrame,
  PageHeader,
  SearchInput,
  Skeleton,
  Spinner,
  toastError,
} from "@prismshadow/penguin-ui";
import * as api from "../../api/endpoints";
import { ApiError } from "../../api/client";
import { apiErrorText } from "../../lib/api-error";
import { S } from "../../lib/strings";
import { useDocumentTitle } from "../../lib/use-document-title";
import { useAuth } from "../../state/auth";
import { useLocale } from "../../state/locale";

/** How many entries one slice renders; the market's own listing is thousands long. */
const PAGE = 60;

/** A dsh index's localized text in the reader's language. */
function textOf(value: string | Record<string, string> | undefined, zh: boolean): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return (zh ? value.zh : undefined) ?? value.en ?? Object.values(value)[0] ?? "";
}

export function DshMarketPage() {
  const { user } = useAuth();
  const isAdmin = user?.isAdmin === true;
  const { locale } = useLocale();
  const zh = locale.startsWith("zh");
  useDocumentTitle(S.dshMarket.pageTitle);

  const [data, setData] = useState<DshMarketResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busySource, setBusySource] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** The entries shown: the first page, then one more page per "show more". */
  const [entries, setEntries] = useState<DshEntryItem[]>([]);
  /** The query the request in flight carries; the input's own state may be ahead of it. */
  const queryRef = useRef("");
  /** The selected category chip; undefined is "all". */
  const [category, setCategory] = useState<string | undefined>(undefined);
  const categoryRef = useRef<string | undefined>(undefined);
  const [installing, setInstalling] = useState<string | null>(null);
  const [report, setReport] = useState<DshMarketInstallResponse | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  /** How many times this page has re-asked for a listing with a source still being read. */
  const pendingPolls = useRef(0);
  /** Which listing request is the current one: a slow older answer is dropped, not shown. */
  const requestId = useRef(0);

  /**
   * One page of the market, from the server.
   *
   * The filtering and the paging are the server's: the official index alone is 12 576 plugins
   * (~9 MB of JSON), so the page never holds the whole set. `append` is "show more".
   */
  const load = async ({ append = false }: { append?: boolean } = {}): Promise<void> => {
    const base = append ? entriesRef.current.length : 0;
    const id = (requestId.current += 1);
    try {
      const next = await api.getDshMarket({
        q: queryRef.current,
        category: categoryRef.current,
        offset: base,
        limit: PAGE,
      });
      // A search that was typed after this request went out owns the list now.
      if (id !== requestId.current) return;
      setData(next);
      setEntries((current) => (append ? [...current, ...next.entries] : next.entries));
      setError(null);
      // A source still being read answers with `pending`; the server's read finishes behind the
      // answer, so asking again is what fills the list. Bounded: a source that never answers
      // stays "Reading…" and the rest of the page keeps working.
      if (next.sources.some((source) => source.pending === true) && pendingPolls.current < 40) {
        pendingPolls.current += 1;
        window.setTimeout(() => void load(), 1_500);
      } else if (!next.sources.some((source) => source.pending === true)) {
        pendingPolls.current = 0;
      }
    } catch (err) {
      setError(err instanceof ApiError ? apiErrorText(err) : String(err));
    }
  };

  /** What the list holds right now, for the next page's offset (the state is one render behind). */
  const entriesRef = useRef<DshEntryItem[]>([]);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read on mount; the pending poll re-arms itself
  }, []);

  // Typing narrows through the server, one request per pause rather than per keystroke.
  useEffect(() => {
    const at = window.setTimeout(() => {
      if (queryRef.current === query) return;
      queryRef.current = query;
      pendingPolls.current = 0;
      void load();
    }, 300);
    return () => window.clearTimeout(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the query changes
  }, [query]);

  const sources = data?.sources ?? [];
  /** At least one source has not answered yet: the list below is still filling in. */
  const anyPending = sources.some((source) => source.pending === true);
  /** How many entries match the query on the server (the whole market without one). */
  const total = data?.total ?? 0;

  const addSource = async (): Promise<void> => {
    const value = url.trim();
    if (value === "") return;
    setBusySource(true);
    try {
      setData(await api.addDshMarketSource(value));
      setUrl("");
      setError(null);
    } catch (err) {
      toastError(err instanceof ApiError ? apiErrorText(err) : String(err));
    } finally {
      setBusySource(false);
    }
  };

  const removeSource = async (id: string): Promise<void> => {
    setRemoving(null);
    try {
      setData(await api.removeDshMarketSource(id));
      setError(null);
    } catch (err) {
      toastError(err instanceof ApiError ? apiErrorText(err) : String(err));
    }
  };

  /** Removes a ported package from this server; the response is the listing without it. */
  const uninstall = async (name: string): Promise<void> => {
    setUninstalling(null);
    try {
      setData(await api.uninstallDshPlugin(name));
      setInstallError(null);
    } catch (err) {
      toastError(err instanceof ApiError ? apiErrorText(err) : String(err));
    }
  };

  /**
   * Starts the install and polls its job until it is done or failed. The server does the work in
   * the background because a tarball fetch plus `npm install` outlives one request; a refusal
   * (`dsh_not_adaptable`) arrives as the job's own error, with its reasons.
   */
  const install = async (entry: DshEntryItem): Promise<void> => {
    setInstalling(entry.name);
    setInstallError(null);
    try {
      let job = await api.startDshInstall({ name: entry.name, version: entry.version });
      const deadline = Date.now() + 5 * 60_000;
      while (job.state === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        job = await api.getDshInstallJob(job.id);
      }
      if (job.state === "done" && job.result !== undefined) {
        setReport(job.result);
        // The card's "Installed" line comes from the server's listing, so ask for it again:
        // without this the entry keeps offering an install until the page is reloaded.
        void load();
      } else if (job.state === "failed") {
        // Only a package with nothing to carry is "not convertible"; a download or npm failure
        // is its own sentence, and calling it unconvertible would point at the wrong thing.
        const code = job.error?.code;
        setInstallError(
          code === "dsh_not_adaptable"
            ? S.dshMarket.notAdaptable(job.error?.message ?? "")
            : (job.error?.message ?? S.dshMarket.notAdaptable("")),
        );
      } else {
        setInstallError(S.dshMarket.notAdaptable("安装超时，请稍后在「插件市场」页确认"));
      }
    } catch (err) {
      // 422 is the server refusing the package itself; anything else (a job id lost to a
      // restart, a dropped connection) is its own sentence, not a claim about the package.
      const message = err instanceof ApiError ? apiErrorText(err) : String(err);
      setInstallError(
        err instanceof ApiError && err.status === 422 ? S.dshMarket.notAdaptable(message) : message,
      );
    } finally {
      setInstalling(null);
    }
  };

  return (
    <PageFrame className="[scrollbar-gutter:stable]">
      <PageHeader title={S.dshMarket.pageTitle} info={S.dshMarket.pageDesc} />

      {anyPending && pendingPolls.current >= 40 && (
        <Notice tone="attention" className="mt-4">
          {S.dshMarket.stillReading}
        </Notice>
      )}

      {error !== null && (
        <Notice tone="attention" className="mt-4">
          {S.dshMarket.readFailed(error)}
        </Notice>
      )}

      <Card className="mt-4" padding="none">
        <div className="border-b border-line px-3 py-2">
          <CardHeader
            title={S.dshMarket.sources}
            level={3}
            actions={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  pendingPolls.current = 0;
                  void load();
                }}
              >
                {S.dshMarket.refresh}
              </Button>
            }
          />
        </div>
        <div className="p-3">
          {isAdmin ? (
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput
                value={url}
                onChange={setUrl}
                placeholder={S.dshMarket.sourceUrlPlaceholder}
                className="min-w-0 flex-1"
              />
              <Button
                variant="primary"
                size="sm"
                disabled={busySource || url.trim() === ""}
                onClick={() => void addSource()}
              >
                {busySource ? S.dshMarket.adding : S.dshMarket.add}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">{S.dshMarket.adminOnly}</p>
          )}

          {sources.length === 0 ? (
            <p className="mt-3 text-sm text-ink-muted">{S.dshMarket.sourcesEmpty}</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {sources.map((source) => (
                <li key={source.id} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    {/* The index's own title, when it has one; the URL is the line below either
                        way, so an untitled source is not printed twice. */}
                    {source.title !== "" && source.title !== source.url && (
                      <div className="truncate text-sm text-ink">{source.title}</div>
                    )}
                    <div className="truncate text-xs text-ink-muted">{source.url}</div>
                    {source.error !== undefined && (
                      <div className="mt-1 text-xs text-tone-danger-fg">
                        {S.dshMarket.sourceFailed(source.error)}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-ink-muted">
                    {source.pending === true
                      ? S.dshMarket.sourceReading
                      : S.dshMarket.pluginsCount(source.plugins)}
                  </span>
                  {isAdmin && (
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(source.id)}>
                      {S.dshMarket.remove}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <details className="mt-4 rounded-md border border-line px-3 py-2 text-sm text-ink-muted">
        <summary className="cursor-pointer select-none text-ink">{S.dshMarket.howTitle}</summary>
        <p className="mt-2 leading-relaxed">{S.dshMarket.howBody}</p>
      </details>

      {(data?.categories.length ?? 0) > 1 && (
        <div className="mt-4 flex flex-wrap items-center gap-1">
          {[
            { id: undefined, label: S.dshMarket.allCategories, count: data?.total ?? 0 },
            ...(data?.categories ?? []).map((bucket) => ({
              id: bucket.id,
              label:
                bucket.id === ""
                  ? S.dshMarket.otherCategory
                  : textOf(bucket.title, zh) || bucket.id,
              count: bucket.count,
            })),
          ].map((chip) => {
            const active = chip.id === category;
            return (
              <button
                key={chip.id ?? "all"}
                type="button"
                onClick={() => {
                  setCategory(chip.id);
                  categoryRef.current = chip.id;
                  pendingPolls.current = 0;
                  void load();
                }}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? "border-line-emphasis bg-control-hover text-ink"
                    : "border-line text-ink-muted hover:bg-control-hover"
                }`}
              >
                {chip.label}
                <span className="ml-1 text-ink-subtle">{chip.count}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={S.dshMarket.searchPlaceholder}
          className="min-w-0 flex-1"
        />
        <span className="text-xs text-ink-muted">
          {query.trim() === ""
            ? S.dshMarket.total(total)
            : S.dshMarket.shownOf(entries.length, total)}
        </span>
      </div>

      {installError !== null && (
        <Notice tone="attention" className="mt-3">
          {installError}
        </Notice>
      )}

      {anyPending && entries.length === 0 ? (
        <div className="mt-4 space-y-2">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : data === null && error === null ? (
        <div className="mt-4 space-y-2">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : entries.length === 0 ? (
        <div className="mt-6">
          <EmptyState title={entries.length === 0 ? S.dshMarket.empty : S.dshMarket.noMatch} />
        </div>
      ) : (
        <ul className="mt-4 grid gap-2">
          {entries.map((entry) => (
            <Card as="li" key={`${entry.sourceId}:${entry.name}`} padding="sm">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="truncate text-sm font-medium text-ink">
                      {textOf(entry.title, zh)}
                    </span>
                    <span className="truncate text-xs text-ink-muted">
                      {entry.name}@{entry.version}
                    </span>
                    {entry.author !== undefined && (
                      <span className="text-xs text-ink-muted">· {entry.author}</span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-ink-muted">
                    {textOf(entry.description, zh)}
                  </p>
                  <p className="mt-1 text-xs text-ink-subtle">{S.dshMarket.installHint}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {entry.installedVersion !== undefined && (
                    <span className="text-xs text-ink-muted">
                      {S.dshMarket.installed(entry.installedVersion)}
                    </span>
                  )}
                  <div className="flex items-center gap-1">
                    {entry.installedVersion !== undefined && isAdmin && (
                      <Button variant="ghost" size="sm" onClick={() => setUninstalling(entry.name)}>
                        {S.dshMarket.uninstall}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!isAdmin || installing !== null}
                      onClick={() => void install(entry)}
                    >
                      {installing === entry.name ? (
                        <span className="inline-flex items-center gap-1">
                          <Spinner size="sm" label={S.dshMarket.installing} />
                          {S.dshMarket.installing}
                        </span>
                      ) : (
                        S.dshMarket.install
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </ul>
      )}

      {entries.length < total && (
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => void load({ append: true })}>
            {S.dshMarket.loadMore(Math.min(PAGE, total - entries.length))}
          </Button>
        </div>
      )}

      <ConfirmModal
        open={removing !== null}
        title={S.dshMarket.remove}
        confirmLabel={S.dshMarket.remove}
        cancelLabel={S.dshMarket.cancel}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing !== null) void removeSource(removing);
        }}
      >
        {S.dshMarket.removeConfirm(sources.find((s) => s.id === removing)?.url ?? "")}
      </ConfirmModal>

      <ConfirmModal
        open={uninstalling !== null}
        title={S.dshMarket.uninstall}
        confirmLabel={S.dshMarket.uninstall}
        cancelLabel={S.dshMarket.cancel}
        onClose={() => setUninstalling(null)}
        onConfirm={() => {
          if (uninstalling !== null) void uninstall(uninstalling);
        }}
      >
        {S.dshMarket.uninstallConfirm(
          `@dsh-ported/${uninstalling === null ? "" : uninstalling.split("/").pop()}`,
        )}
      </ConfirmModal>

      <Modal
        open={report !== null}
        title={S.dshMarket.reportTitle}
        onClose={() => setReport(null)}
        footer={
          <Button variant="secondary" size="sm" onClick={() => setReport(null)}>
            {S.dshMarket.close}
          </Button>
        }
      >
        {report !== null && (
          <div className="space-y-2 text-sm text-ink">
            <p>{S.dshMarket.reportIntro(report.name, report.version)}</p>
            {report.skills.length > 0 && (
              <p>{S.dshMarket.reportSkills(report.skills.map((s) => s.name))}</p>
            )}
            {report.mcpServers.length > 0 && <p>{S.dshMarket.reportMcp(report.mcpServers)}</p>}
            <p className="text-xs text-ink-subtle">
              {report.source.kind === "npm"
                ? S.dshMarket.sourceNpm
                : S.dshMarket.sourceGit(report.source.commit?.slice(0, 12) ?? "")}
            </p>
            {report.skills.some((skill) => skill.needsSetup === true) && (
              <div className="rounded-md border border-line px-2 py-1.5 text-ink-muted">
                <p>{S.dshMarket.needsSetup}</p>
                <ul className="mt-1 space-y-0.5 font-mono text-xs">
                  {report.skills
                    .filter((skill) => skill.needsSetup === true)
                    .map((skill) => (
                      <li key={skill.name}>
                        cd agent_state/skills/{skill.name} && npm install --omit=dev
                      </li>
                    ))}
                </ul>
              </div>
            )}
            {report.dropped.length > 0 && (
              <p className="text-ink-muted">{S.dshMarket.reportDropped(report.dropped)}</p>
            )}
            {report.warnings.length > 0 && (
              <p className="text-ink-muted">{S.dshMarket.reportWarnings(report.warnings)}</p>
            )}
          </div>
        )}
      </Modal>
    </PageFrame>
  );
}
