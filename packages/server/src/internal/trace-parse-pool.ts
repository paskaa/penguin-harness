/**
 * Off-loop trace parsing: a single long-lived worker thread that reads + parses Trace
 * shard files, keeping the multi-second synchronous CPU work of parseTraceLines OFF the
 * server's event loop. One worker suffices — parsing is already serialized by the
 * callers, and the shard cache means repeats never reach here.
 *
 * Fallback contract: if the worker cannot spawn or dies mid-parse, callers get an
 * error and re-run the parse synchronously (readTraceTolerant) — correct, just
 * event-loop-blocking, exactly the pre-worker behavior.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { AmspRecord } from "@prismshadow/penguin-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, "trace-parse-worker.cjs");
const PARSE_TIMEOUT_MS = 60_000;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<
  number,
  { resolve: (messages: AmspRecord[]) => void; reject: (err: Error) => void }
>();

function dropWorker(): void {
  worker = null;
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(new Error("trace parse worker exited"));
  }
}

function getWorker(): Worker {
  if (worker === null) {
    worker = new Worker(workerPath);
    worker.on("message", (msg: { id: number; messages?: AmspRecord[]; error?: string }) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.messages ?? []);
    });
    worker.on("error", () => dropWorker());
    worker.on("exit", () => dropWorker());
  }
  return worker;
}

/** Read + parse one Trace shard in the worker thread. Rejects on failure/timeout. */
export function parseTraceFileOffLoop(path: string): Promise<AmspRecord[]> {
  const w = getWorker();
  const id = ++seq;
  return new Promise<AmspRecord[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error("trace parse timeout"));
    }, PARSE_TIMEOUT_MS);
    pending.set(id, {
      resolve: (messages) => {
        clearTimeout(timer);
        resolve(messages);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    w.postMessage({ id, path });
  });
}
