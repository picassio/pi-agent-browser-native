#!/usr/bin/env node
/**
 * Purpose: Produce the compiled runtime files that the published Pi package loads.
 * Responsibilities: Compile clean output in staging, publish it after successful TypeScript emit, and fail with clear build output.
 * Scope: Maintainer/package build only; runtime behavior remains in extensions/agent-browser TypeScript sources.
 * Usage: `npm run build` before package verification, lifecycle validation, and npm pack/publish.
 * Invariants/Assumptions: `node_modules` is installed and provides `typescript`; staging lives beside `dist/` so file publication uses same-filesystem renames.
 */

import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const binSuffix = process.platform === "win32" ? ".cmd" : "";
const tscPath = join(process.cwd(), "node_modules", ".bin", `tsc${binSuffix}`);
const entrypointRelativePath = join("extensions", "agent-browser", "index.js");

async function collectFiles(rootPath, relativePath = "") {
	const files = [];
	for (const entry of await readdir(join(rootPath, relativePath), { withFileTypes: true })) {
		const entryRelativePath = join(relativePath, entry.name);
		if (entry.isDirectory()) files.push(...await collectFiles(rootPath, entryRelativePath));
		else if (entry.isFile()) files.push(entryRelativePath);
	}
	return files;
}

async function publishStagedDist(stagingDistPath, distPath, previousDistPath) {
	const stagedFiles = await collectFiles(stagingDistPath);
	if (!stagedFiles.includes(entrypointRelativePath)) {
		throw new Error(`Compiled output is missing ${entrypointRelativePath}`);
	}

	let previousFiles = [];
	let hadPreviousDist = true;
	try {
		previousFiles = await collectFiles(distPath);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		hadPreviousDist = false;
	}
	if (hadPreviousDist) await cp(distPath, previousDistPath, { recursive: true });

	try {
		const orderedFiles = stagedFiles.toSorted((left, right) =>
			left === entrypointRelativePath ? 1 : right === entrypointRelativePath ? -1 : left.localeCompare(right));
		for (const relativePath of orderedFiles) {
			const targetPath = join(distPath, relativePath);
			await mkdir(dirname(targetPath), { recursive: true });
			await rename(join(stagingDistPath, relativePath), targetPath);
		}
		const currentFiles = new Set(stagedFiles);
		for (const relativePath of previousFiles) {
			if (!currentFiles.has(relativePath)) await rm(join(distPath, relativePath), { force: true });
		}
	} catch (error) {
		await rm(distPath, { force: true, recursive: true });
		if (hadPreviousDist) await rename(previousDistPath, distPath);
		throw error;
	}
}

async function main() {
	const cwd = process.cwd();
	const distPath = join(cwd, "dist");
	const stagingRoot = await mkdtemp(join(cwd, "node_modules", ".pi-agent-browser-dist-"));
	const stagingDistPath = join(stagingRoot, "dist");
	const previousDistPath = join(stagingRoot, "previous-dist");
	const options = process.platform === "win32" ? { shell: true } : {};
	try {
		const { stderr, stdout } = await execFile(tscPath, ["-p", "tsconfig.build.json", "--outDir", stagingDistPath], {
			...options,
			cwd,
			maxBuffer: 10 * 1024 * 1024,
		});
		if (stdout) process.stdout.write(stdout);
		if (stderr) process.stderr.write(stderr);
		await publishStagedDist(stagingDistPath, distPath, previousDistPath);
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
