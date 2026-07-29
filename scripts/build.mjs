#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the published Pi package loads.
 * Responsibilities: Compile clean output in staging, publish it after successful TypeScript emit, and fail with clear build output.
 * Scope: Maintainer/package build only; runtime behavior remains in extensions/agent-browser TypeScript sources.
 * Usage: `npm run build` before package verification, lifecycle validation, and npm pack/publish.
 * Invariants/Assumptions: `node_modules` is installed and provides `typescript`; staging lives beside `dist/` so publication uses same-filesystem renames.
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const binSuffix = process.platform === "win32" ? ".cmd" : "";
const tscPath = join(process.cwd(), "node_modules", ".bin", `tsc${binSuffix}`);

async function main() {
	const cwd = process.cwd();
	const distPath = join(cwd, "dist");
	const stagingRoot = await mkdtemp(join(cwd, "node_modules", ".pi-agent-browser-dist-"));
	const stagingDistPath = join(stagingRoot, "dist");
	const previousDistPath = join(stagingRoot, "previous-dist");
	const options = process.platform === "win32" ? { shell: true } : {};
	let previousDistMoved = false;
	try {
		const { stderr, stdout } = await execFile(tscPath, ["-p", "tsconfig.build.json", "--outDir", stagingDistPath], {
			...options,
			cwd,
			maxBuffer: 10 * 1024 * 1024,
		});
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
		try {
			await rename(distPath, previousDistPath);
			previousDistMoved = true;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		try {
			await rename(stagingDistPath, distPath);
		} catch (error) {
			if (previousDistMoved) await rename(previousDistPath, distPath);
			throw error;
		}
	} catch (error) {
		if (error?.stdout) process.stdout.write(error.stdout);
		if (error?.stderr) process.stderr.write(error.stderr);
		throw error;
	} finally {
		await rm(stagingRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
