/**
 * The dsh console's routes.
 *
 *   GET  /api/dsh/console        status: installed? running? which URL? (any user — it is a
 *                                read of deployment state, and the page needs it to render)
 *   POST /api/dsh/console/start  start (or return) the console (admin)
 *   POST /api/dsh/console/stop   stop it (admin)
 *
 * Why a route at all: the panel is a page that embeds dsh's own Web UI, and that UI has to be
 * started somewhere. Starting it here keeps one console per server, under the server's own
 * lifetime, instead of every browser tab spawning a process.
 */
import { Hono } from "hono";
import { Bind, Component, Use } from "@prismshadow/penguin-core/kernel";
import type { Config } from "../../hmr/capabilities.js";
import type { AppEnv } from "../../auth/middleware.js";
import { HttpError } from "../../http/errors.js";
import type { DshConsoleStatus } from "../../api/types.js";
import { DshConsole } from "../../dsh/console.js";

function requireAdmin(c: { var: AppEnv["Variables"] }): void {
  if (!c.var.user.isAdmin) {
    throw new HttpError(403, "admin_required", "只有管理员可以启动或停止 DSH 控制台。");
  }
}

export function dshConsoleRoutes(console: DshConsole): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/", async (c) => c.json((await console.describe()) satisfies DshConsoleStatus));
  app.post("/start", async (c) => {
    requireAdmin(c);
    return c.json((await console.start()) satisfies DshConsoleStatus);
  });
  app.post("/stop", async (c) => {
    requireAdmin(c);
    return c.json((await console.stop()) satisfies DshConsoleStatus);
  });
  return app;
}

/**
 * The console, once per server: its process, its routes, and its death with this process.
 *
 * `root` is accepted for symmetry with the other route modules — the console keeps nothing on
 * disk; dsh owns its own profiles under the user's home.
 */
@Component({
  contributes: {
    "HttpModule.routes": [
      { id: "DshConsoleRoutes.routes", prefix: "/api/dsh/console", auth: "user", order: 71 },
    ],
  },
})
export class DshConsoleRoutes {
  @Use() private readonly config!: Config;
  @Bind("DshConsoleRoutes.routes") routes!: Hono<AppEnv>;
  private console!: DshConsole;
  setup() {
    // One console for the App's lifetime. Re-assembly (a plugin installed) makes a new App, but
    // the module instance is reused across assemblies, so the child survives a re-assembly.
    this.console ??= new DshConsole();
    this.routes = dshConsoleRoutes(this.console);
    void this.config;
  }
}
