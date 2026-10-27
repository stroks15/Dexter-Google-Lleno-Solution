import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["api", "src"];
const files = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && full.endsWith(".js")) files.push(full);
  }
}
for (const root of roots) walk(root);
if (!files.length) throw new Error("No JavaScript source files found to validate");
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || ("Syntax check failed: " + file));
    process.exit(result.status || 1);
  }
}
console.log(`JavaScript syntax validation passed for ${files.length} files.`);
