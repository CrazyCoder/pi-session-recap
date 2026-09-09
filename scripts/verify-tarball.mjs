// Run the regression suite against the actual npm artifact, not the source tree.
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Stay below the root so the extracted extension resolves development peers.
const work = mkdtempSync(join(root, ".recap-pack-"));
try {
  const result = JSON.parse(execSync(`npm pack --json --pack-destination "${work}"`, {
    cwd: root, encoding: "utf8",
  }));
  // npm 11 returns an array; npm 12 keys the result by package name.
  const [packed] = Object.values(result);
  assert.deepEqual(packed.files.map((file) => file.path).sort(), [
    "CHANGELOG.md", "LICENSE", "README.md", "assets/recap.png", "index.ts", "package.json",
  ]);
  execFileSync("tar", ["-xzf", packed.filename], { cwd: work });
  const pkg = join(work, "package");
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  assert.equal(manifest.name, "@jetserge/pi-session-recap");
  assert.deepEqual(manifest.pi.extensions, ["index.ts"]);
  assert.deepEqual(readFileSync(join(pkg, "index.ts")), readFileSync(join(root, "index.ts")));
  cpSync(join(root, "tests"), join(pkg, "tests"), { recursive: true });
  const tests = readdirSync(join(pkg, "tests")).filter((name) => name.endsWith(".test.mjs"));
  assert.ok(tests.length > 0);
  execFileSync(process.execPath, ["--test", ...tests.map((name) => join(pkg, "tests", name))], {
    cwd: pkg, stdio: "inherit",
  });
  console.log(`Verified ${packed.filename}: ${packed.files.length} files; packed extension passes regression tests.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
