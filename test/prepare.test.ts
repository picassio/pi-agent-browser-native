/**
 * Purpose: Verify source-install preparation detects installed build dependencies before invoking npm.
 * Responsibilities: Cover import-only package exports and the canonical build handoff.
 * Scope: Package prepare lifecycle only; build output and package contents are tested elsewhere.
 * Usage: Run with `npx tsx --test test/prepare.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Fixtures use isolated package trees and fake npm/build scripts without network access.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function writeFixturePackage(root: string, name: string, packageJson: Record<string, unknown>): Promise<void> {
	const packageDir = join(root, "node_modules", ...name.split("/"));
	await mkdir(packageDir, { recursive: true });
	await writeFile(join(packageDir, "package.json"), JSON.stringify({ name, ...packageJson }), "utf8");
	await writeFile(join(packageDir, "index.js"), "export {};\n", "utf8");
}

test("prepare distinguishes installed import-only build dependencies from missing dependencies", async () => {
	const fixtureDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-prepare-"));
	const preparePath = join(fixtureDir, "scripts", "prepare.mjs");
	const buildMarker = join(fixtureDir, "build-ran");
	const npmMarker = join(fixtureDir, "nested-npm-ran");
	const fakeNpmPath = join(fixtureDir, "fake-npm.mjs");

	try {
		await mkdir(dirname(preparePath), { recursive: true });
		await writeFile(preparePath, await readFile("scripts/prepare.mjs", "utf8"), "utf8");
		for (const name of ["typescript", "typebox", "@earendil-works/pi-tui"]) {
			await writeFixturePackage(fixtureDir, name, { main: "./index.js", type: "module" });
		}
		await writeFixturePackage(fixtureDir, "@earendil-works/pi-coding-agent", {
			exports: { ".": { import: "./index.js" } },
			type: "module",
		});
		await writeFile(join(fixtureDir, "scripts", "build.mjs"), `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(buildMarker)}, "ok");\n`, "utf8");
		await writeFile(fakeNpmPath, `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(npmMarker)}, "unexpected");\n`, "utf8");

		await execFileAsync(process.execPath, [preparePath], {
			cwd: fixtureDir,
			env: { ...process.env, npm_execpath: fakeNpmPath },
		});

		await access(buildMarker);
		await assert.rejects(access(npmMarker), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

		await rm(join(fixtureDir, "node_modules", "@earendil-works", "pi-coding-agent"), { force: true, recursive: true });
		await rm(buildMarker, { force: true });
		await execFileAsync(process.execPath, [preparePath], {
			cwd: fixtureDir,
			env: { ...process.env, npm_execpath: fakeNpmPath },
		});
		await access(npmMarker);
		await access(buildMarker);
	} finally {
		await rm(fixtureDir, { force: true, recursive: true });
	}
});
