
import pg from "pg";
import { translateStatement } from "./dist/db/pg/shim-entry.js";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/root/penguin/scratchpad/ph-0216/packages/server/src";
const dirs = ["db/repos", "services", "mechanisms", "http/routes", "runtime", "internal", "db"];
const files = new Set();
for (const d of dirs) {
  const full = path.join(ROOT, d);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full, { recursive: true })) {
    if (String(f).endsWith(".ts")) files.add(path.join(full, String(f)));
  }
}

function extract(src) {
  const out = [];
  const re = /\.(prepare|exec)\(\s*(`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,?\s*\)/gs;
  let m;
  while ((m = re.exec(src)) !== null) {
    let lit = m[2].slice(1, -1);
    if (lit.length < 8) continue;
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|PRAGMA|CREATE|DROP|BEGIN|COMMIT|ROLLBACK)/i.test(lit)) continue;
    out.push(lit);
  }
  return out;
}

const client = new pg.Client({ host: "127.0.0.1", port: 15432, database: "tracker", user: "root", password: "Jchl1528" });
await client.connect(); await client.query("SET search_path TO penguin");
const pkCache = new Map();
async function pkOf(table) {
  if (pkCache.has(table)) return pkCache.get(table);
  // 表名可能带 schema 前缀；默认 penguin
  const bare = table.split(".").pop();
  const r = await client.query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = 'penguin' AND c.relname = $1 AND i.indisprimary ORDER BY a.attnum`, [bare]);
  const cols = r.rows.map((x) => x.attname);
  pkCache.set(table, cols);
  return cols;
}

let total = 0, fail = 0, skipped = 0;
const failures = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf-8");
  for (let sql of extract(src)) {
    total += 1;
    sql = sql.replace(/\$\{[^}]*\}/g, "__DYN__");
    let translated;
    try {
      translated = translateStatement(sql, { pkOf: (t) => pkOf(t) });
    } catch (e) {
      fail += 1;
      failures.push([f, sql.slice(0, 110).replace(/\s+/g, " "), "TRANSLATE: " + String(e).slice(0, 140)]);
      continue;
    }
    if (!translated) { skipped += 1; continue; }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(translated)) { skipped += 1; continue; }
    const forExplain = translated
      .replace(/__DYN__/g, "NULL")
      .replace(/\?/g, "NULL")
      .replace(/\$\d+/g, "NULL")
      .trim().replace(/;$/, "");
    try {
      await client.query("EXPLAIN " + forExplain);
    } catch (e) {
      // PRAGMA 仿真/SET 等非计划语句跳过
      const msg = String(e.message || e);
      if (/cannot run EXPLAIN|SET search_path|_pg_meta/i.test(msg)) { skipped += 1; continue; }
      fail += 1;
      failures.push([f, sql.slice(0, 110).replace(/\s+/g, " "), msg.slice(0, 150)]);
    }
  }
}
console.log(`TOTAL=${total} FAIL=${fail} SKIP=${skipped}`);
for (const [f, sql, msg] of failures.slice(0, 30)) {
  console.log("---", f.replace(ROOT + "/", ""), "|", sql, "|", msg);
}
await client.end();

