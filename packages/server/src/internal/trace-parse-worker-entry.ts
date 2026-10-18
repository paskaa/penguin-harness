/**
 * Trace parse worker entry (CommonJS bundle, built by tsup's onSuccess esbuild step
 * the same way db/pg/worker.cjs is).
 *
 * Reads one Trace shard file and parses it OFF the server's event loop: parseTraceLines
 * is synchronous CPU work that freezes the whole process on multi-MB shards (measured:
 * a cold parse stalls every other endpoint for seconds). This worker does the read +
 * parse in its own thread and posts the plain-JSON messages back (OmniMessage rows come
 * from JSON.parse, so they structured-clone cheaply).
 */
import { parentPort } from "node:worker_threads";
import { readTraceTolerant } from "@prismshadow/penguin-core";

parentPort?.on("message", async (msg: { id: number; path: string }) => {
  try {
    const messages = await readTraceTolerant(msg.path);
    parentPort?.postMessage({ id: msg.id, messages });
  } catch (err) {
    parentPort?.postMessage({ id: msg.id, error: String((err as Error)?.message ?? err) });
  }
});
