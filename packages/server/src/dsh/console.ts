/**
 * The dsh console: a DeepSeek Harness Web UI this server starts and hands to the browser.
 *
 * WHY. A dsh plugin that contributes UI does it through client slots (`ctx.slots.register`,
 * `ctx.slots.inject`) — React components injected into dsh's own Web client. That client is a
 * React app wired to dsh's service graph; loading one of its components here would mean
 * re-implementing that client. So the client runs where it works: this module starts `dsh web`
 * as a child process and the console page embeds it. Every slot plugin then renders exactly as
 * its author intended, inside the panel.
 *
 * The child is one process per server, started on demand by an admin, and stopped when the
 * console is closed or this process exits. A dsh that is not installed, or that needs setup
 * first, is reported as such rather than left as a spinner.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";

/** The dsh binary: PATH, or DSH_BIN when the service PATH is not where dsh lives. */
const DSH_BIN = process.env.DSH_BIN ?? "dsh";
/** How long dsh may take to answer after it starts listening. */
const START_TIMEOUT_MS = 90_000;
/** A console left running for days is a console nobody is looking at. */
const IDLE_STOP_MS = 6 * 60 * 60_000;

export type DshConsoleState = "stopped" | "starting" | "running" | "failed";

export interface DshConsoleStatus {
  state: DshConsoleState;
  /** The URL the panel embeds, when running. */
  url?: string;
  port?: number;
  /** Unix milliseconds. */
  startedAt?: number;
  /** Why it could not start (or stopped being reachable). */
  error?: string;
  /** False when no `dsh` binary answers `--version`. */
  installed: boolean;
  /** What `dsh --version` printed, when installed. */
  version?: string;
}

/** A port nothing is listening on, chosen by the OS and released immediately. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

/** Whether `dsh` runs here, and its version; runs it once with the environment a child gets. */
async function probe(): Promise<{ installed: boolean; version?: string; error?: string }> {
  return await new Promise((resolve) => {
    const child = spawn(DSH_BIN, ["--version"], {
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (out += chunk.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ installed: false, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (code === 0 && text !== "") resolve({ installed: true, version: text.split("\n")[0] });
      else resolve({ installed: false, error: text || `dsh exited with ${code}` });
    });
  });
}

/**
 * The environment a dsh child gets: this process's Node first on PATH and no inherited
 * `NODE_OPTIONS`. The service may run on a Node whose preload flags dsh cannot satisfy, and a
 * PATH whose `node` is older than dsh needs — both were real failures here.
 */
function childEnv(): NodeJS.ProcessEnv {
  const nodeDir = path.dirname(process.execPath);
  const rest = (process.env.PATH ?? "").split(path.delimiter).filter((part) => part !== nodeDir);
  return {
    ...process.env,
    PATH: `${nodeDir}${path.delimiter}${rest.join(path.delimiter)}`,
    NODE_OPTIONS: "",
  };
}

/** The console page's one process, owned by this server. */
export class DshConsole {
  private child: ChildProcess | null = null;
  private state: DshConsoleState = "stopped";
  private url: string | undefined;
  private port: number | undefined;
  private startedAt: number | undefined;
  private error: string | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly onChange: (status: DshConsoleStatus) => void;

  constructor(onChange: (status: DshConsoleStatus) => void = () => {}) {
    this.onChange = onChange;
    // A console that outlives the server is a stray process on a port nobody owns.
    const stop = (): void => {
      void this.stop();
    };
    process.once("exit", stop);
    process.once("SIGTERM", stop);
  }

  status(): DshConsoleStatus {
    return {
      state: this.state,
      installed: true,
      ...(this.url === undefined ? {} : { url: this.url }),
      ...(this.port === undefined ? {} : { port: this.port }),
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  /** Status with the binary probe folded in: the page shows "not installed" before any start. */
  async describe(): Promise<DshConsoleStatus> {
    if (this.state !== "stopped" && this.state !== "failed") return this.status();
    const probeResult = await probe();
    return {
      ...this.status(),
      installed: probeResult.installed,
      ...(probeResult.version === undefined ? {} : { version: probeResult.version }),
      ...(this.error === undefined && probeResult.error !== undefined && !probeResult.installed
        ? { error: probeResult.error }
        : {}),
    };
  }

  /** Starts `dsh web` on a free port and waits until it answers; idempotent while running. */
  async start(): Promise<DshConsoleStatus> {
    if (this.state === "running" && this.url !== undefined) return this.status();
    if (this.state === "starting") return this.status();

    const probeResult = await probe();
    if (!probeResult.installed) {
      this.state = "failed";
      this.error = `dsh 不可用：${probeResult.error ?? "未安装"}`;
      this.onChange(this.status());
      return this.status();
    }

    const port = await freePort();
    this.state = "starting";
    this.error = undefined;
    this.onChange(this.status());

    const child = spawn(
      DSH_BIN,
      ["web", "--no-open", "--host", "127.0.0.1", "--port", String(port)],
      {
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    let log = "";
    child.stdout.on("data", (chunk) => (log += chunk.toString("utf8").slice(0, 8_000)));
    child.stderr.on("data", (chunk) => (log += chunk.toString("utf8").slice(0, 8_000)));
    child.on("exit", (code, signal) => {
      this.child = null;
      if (this.state === "stopped") return;
      this.state = "failed";
      this.error = `dsh web 退出了（${signal ?? code}）。${log.trim().split("\n").slice(-3).join(" ")}`;
      this.url = undefined;
      this.port = undefined;
      this.onChange(this.status());
    });

    // dsh prints the URL it serves, with the token its browser fence requires:
    //   dsh web: http://127.0.0.1:39914/?token=…
    // That URL — not the bare root — is what the panel must embed, or the frame gets a 401 page.
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child === null) break; // it exited
      const match = /(https?:\/\/[^\s]*(?:token=|\?)[^\s]*)/.exec(log);
      if (match !== null) {
        this.state = "running";
        this.url = match[1]!;
        this.port = port;
        this.startedAt = Date.now();
        this.armIdleStop();
        this.onChange(this.status());
        return this.status();
      }
      await new Promise((done) => setTimeout(done, 500));
    }

    if (this.state === "starting") {
      this.state = "failed";
      this.error = `dsh web 在 ${START_TIMEOUT_MS / 1000}s 内没有应答`;
      void this.stopChild();
    }
    this.onChange(this.status());
    return this.status();
  }

  /** Stops the child if it is ours; safe to call when stopped. */
  async stop(): Promise<DshConsoleStatus> {
    this.state = "stopped";
    this.url = undefined;
    this.port = undefined;
    this.startedAt = undefined;
    this.error = undefined;
    await this.stopChild();
    this.onChange(this.status());
    return this.status();
  }

  private async stopChild(): Promise<void> {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const child = this.child;
    this.child = null;
    if (child === null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private armIdleStop(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.stop(), IDLE_STOP_MS);
    this.idleTimer.unref();
  }
}
