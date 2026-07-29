/**
 * Purpose: Verify generated package output remains readable while a clean rebuild compiles.
 * Scope: Focused build publication lifecycle coverage with an isolated fake TypeScript compiler.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function waitForChild(child: ReturnType<typeof spawn>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
	child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
	const exitCode = await new Promise<number | null>((resolveExit, reject) => {
		child.once("error", reject);
		child.once("close", resolveExit);
	});
	return { exitCode, stderr, stdout };
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

test("build keeps the dist entrypoint continuously readable while publishing", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-build-publish-"));
	const readerStartedPath = join(tempDir, "reader-started");
	const stopReaderPath = join(tempDir, "stop-reader");
	const entrypoint = join(tempDir, "dist", "extensions", "agent-browser", "index.js");
	const staleOutputPath = join(tempDir, "dist", "stale.js");
	const buildScript = resolve("scripts/build.mjs");
	const compilerPath = join(tempDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

	try {
		await mkdir(join(tempDir, "dist", "extensions", "agent-browser"), { recursive: true });
		await mkdir(join(tempDir, "node_modules", ".bin"), { recursive: true });
		await writeFile(entrypoint, "build 0\n", "utf8");
		await writeFile(staleOutputPath, "stale\n", "utf8");
		await writeFile(join(tempDir, "tsconfig.build.json"), "{}\n", "utf8");
		await writeFile(
			compilerPath,
			`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const outDir = args[args.indexOf("--outDir") + 1];
const entrypoint = path.resolve(process.cwd(), outDir, "extensions", "agent-browser", "index.js");
fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
fs.writeFileSync(entrypoint, "build " + process.env.BUILD_NUMBER + "\\n");
`,
			"utf8",
		);
		await chmod(compilerPath, 0o755);

		const reader = spawn(process.execPath, ["-e", `
const fs = require("node:fs");
const entrypoint = ${JSON.stringify(entrypoint)};
const stopPath = ${JSON.stringify(stopReaderPath)};
let invalidReads = 0;
let missingReads = 0;
let successfulReads = 0;
fs.writeFileSync(${JSON.stringify(readerStartedPath)}, "started");
while (!fs.existsSync(stopPath)) {
  try {
    const value = fs.readFileSync(entrypoint, "utf8");
    if (!/^build \\d+\\n$/.test(value)) invalidReads += 1;
    else successfulReads += 1;
  } catch (error) {
    if (error && error.code === "ENOENT") missingReads += 1;
    else throw error;
  }
}
process.stdout.write(JSON.stringify({ invalidReads, missingReads, successfulReads }));
`], { cwd: tempDir, stdio: ["ignore", "pipe", "pipe"] });

		await waitForFile(readerStartedPath);
		try {
			for (let buildNumber = 1; buildNumber <= 25; buildNumber += 1) {
				const result = await waitForChild(spawn(process.execPath, [buildScript], {
					cwd: tempDir,
					env: { ...process.env, BUILD_NUMBER: String(buildNumber) },
					stdio: ["ignore", "pipe", "pipe"],
				}));
				assert.equal(result.exitCode, 0, `build ${buildNumber} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
			}
		} finally {
			await writeFile(stopReaderPath, "stop", "utf8");
		}

		const readerResult = await waitForChild(reader);
		assert.equal(readerResult.exitCode, 0, `reader failed\nstderr:\n${readerResult.stderr}`);
		const counts = JSON.parse(readerResult.stdout) as { invalidReads: number; missingReads: number; successfulReads: number };
		assert.ok(counts.successfulReads > 0, "reader did not observe the entrypoint");
		assert.equal(counts.invalidReads, 0, `reader observed ${counts.invalidReads} partial or invalid entrypoints`);
		assert.equal(counts.missingReads, 0, `reader observed ${counts.missingReads} ENOENT publication windows`);
		assert.equal(await readFile(entrypoint, "utf8"), "build 25\n");
		await assert.rejects(readFile(staleOutputPath), { code: "ENOENT" });

		await writeFile(
			compilerPath,
			`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const outDir = args[args.indexOf("--outDir") + 1];
const partial = path.resolve(process.cwd(), outDir, "extensions", "agent-browser", "index.js");
fs.mkdirSync(path.dirname(partial), { recursive: true });
fs.writeFileSync(partial, "partial build\\n");
process.stderr.write("intentional compiler failure\\n");
process.exitCode = 2;
`,
			"utf8",
		);
		const compilerFailure = await waitForChild(spawn(process.execPath, [buildScript], {
			cwd: tempDir,
			stdio: ["ignore", "pipe", "pipe"],
		}));
		assert.notEqual(compilerFailure.exitCode, 0);
		assert.match(compilerFailure.stderr, /intentional compiler failure/);
		assert.equal(await readFile(entrypoint, "utf8"), "build 25\n");

		await writeFile(compilerPath, "#!/usr/bin/env node\n", "utf8");
		const missingOutputFailure = await waitForChild(spawn(process.execPath, [buildScript], {
			cwd: tempDir,
			stdio: ["ignore", "pipe", "pipe"],
		}));
		assert.notEqual(missingOutputFailure.exitCode, 0);
		assert.match(missingOutputFailure.stderr, /Compiled output is missing|ENOENT/);
		assert.equal(await readFile(entrypoint, "utf8"), "build 25\n");
		assert.deepEqual(
			(await readdir(join(tempDir, "node_modules"))).filter((name) => name.startsWith(".pi-agent-browser-dist-")),
			[],
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
