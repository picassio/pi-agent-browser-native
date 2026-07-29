/**
 * Purpose: Verify generated package output remains readable while a clean rebuild compiles.
 * Scope: Focused build publication lifecycle coverage with an isolated fake TypeScript compiler.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		try {
			await readFile(path);
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await new Promise((resolveWait) => setTimeout(resolveWait, 5));
		}
	}
}

test("build keeps the previous dist entrypoint readable until compilation completes", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-build-"));
	const startedPath = join(tempDir, "compiler-started");
	const releasePath = join(tempDir, "release-compiler");
	const entrypoint = join(tempDir, "dist", "extensions", "agent-browser", "index.js");
	const buildScript = resolve("scripts/build.mjs");
	const compilerPath = join(tempDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

	try {
		await mkdir(join(tempDir, "dist", "extensions", "agent-browser"), { recursive: true });
		await mkdir(join(tempDir, "node_modules", ".bin"), { recursive: true });
		await writeFile(entrypoint, "previous build\n", "utf8");
		await writeFile(join(tempDir, "tsconfig.build.json"), "{}\n", "utf8");
		await writeFile(
			compilerPath,
			`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const outDirIndex = args.indexOf("--outDir");
const outDir = outDirIndex >= 0 ? args[outDirIndex + 1] : "dist";
fs.writeFileSync(${JSON.stringify(startedPath)}, "started");
while (!fs.existsSync(${JSON.stringify(releasePath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const entrypoint = path.resolve(process.cwd(), outDir, "extensions", "agent-browser", "index.js");
fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
fs.writeFileSync(entrypoint, "current build\\n");
`,
			"utf8",
		);
		await chmod(compilerPath, 0o755);

		const child = spawn(process.execPath, [buildScript], { cwd: tempDir, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		const completed = new Promise<number | null>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("close", resolveExit);
		});

		await waitForFile(startedPath);
		let duringBuild: string | undefined;
		let readError: unknown;
		try {
			duringBuild = await readFile(entrypoint, "utf8");
		} catch (error) {
			readError = error;
		} finally {
			await writeFile(releasePath, "release", "utf8");
		}

		const exitCode = await completed;
		assert.equal(exitCode, 0, `build failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
		assert.ifError(readError);
		assert.equal(duringBuild, "previous build\n");
		assert.equal(await readFile(entrypoint, "utf8"), "current build\n");
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
