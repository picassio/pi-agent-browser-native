/**
 * Purpose: Derive operator prompt constraints for browser-run preflight guards and legacy bash policy.
 * Responsibilities: Parse the latest user message into requested artifact paths and legacy bash allowance.
 * Scope: Pure prompt-text policy; enforcement lives in orchestration prompt-guards and the extension entrypoint.
 */

export interface PromptRequestedArtifact {
	kind: "recording" | "screenshot";
	path: string;
	required: boolean;
}

export interface PromptPolicy {
	allowLegacyAgentBrowserBash: boolean;
	requestedArtifacts: PromptRequestedArtifact[];
}

const BROWSER_PROMPT_PATTERNS = [
	/\b(?:agent[_ -]?browser|browser automation|eval\s+--stdin|screenshot|snapshot|tab\s+list)\b/i,
	/\b(?:react\s+(?:tree|inspect|renders|suspense)|web\s+vitals|core\s+web\s+vitals|pushstate)\b/i,
	/\b(?:live\s+docs?|online\s+research|research\s+(?:online|the\s+web)|search\s+(?:online|the\s+web)|web\s+research)\b/i,
	/\bbrowser\b.*\b(?:automation|click|fill|navigate|open|page|screenshot|site|snapshot|tab|url|visit|web(?:site| page)?)\b/i,
	/\b(?:browse|click|fill|login|navigate|open|visit)\b.*\b(?:https?:\/\/\S+|page|site|tab|url|web(?:site| page)?)\b/i,
];

const LEGACY_BASH_ALLOW_PATTERNS = [
	/\b(?:bash-oriented workflow|bash workflow)\b/i,
	/\b(?:use|via|through|with)\s+bash\b/i,
	/\bnpx\s+agent-browser\b/i,
	/\bagent-browser\s+--(?:help|version)\b/i,
	/\bdebug(?:ging)?\b.*\b(?:agent[_ -]?browser|agent_browser|browser integration)\b/i,
];

const PROMPT_ARTIFACT_PATH_PATTERN = /(?:^|[\s"'`(:])((?:\/[^\s"'`),;]+|[A-Za-z]:[\\/][^\s"'`),;]+|\.{1,2}[\\/][^\s"'`),;]+|[^\s"'`),;:\\/]+(?:[\\/][^\s"'`),;]+)+|[^\s"'`),;:\\/]+)\.(?:png|jpe?g|webp|gif|webm|mp4|har|pdf|trace|json))(?:[\s"'`),;.]|$)/gi;
const PROMPT_ARTIFACT_REQUEST_PATTERN = /(?:\b(?:save|capture|take|write|store|produce|create)\b[^.!?]*\b(?:screenshots?|screen\s+recordings?|recordings?|videos?)\b|\b(?:required\s+)?(?:screenshots?|screen\s+recordings?|recordings?|videos?)(?:\s+(?:path|file))?\s*(?:here\s*)?(?::|=|\bto\b|\bat\b))/i;
const INSTRUCTIONAL_ARTIFACT_LINE_PATTERN = /(?:^\s*(?:(?:[-*]\s*)?[❌✅]?\s*)?(?:(?:malformed\s+)?example|wrong|right)\s*:|\b(?:as an?|for(?: an?)?) example\b|!\[[^\n]*\]\s*\()/i;
const MARKDOWN_FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

function inferPromptArtifactKind(line: string, path: string): PromptRequestedArtifact["kind"] | undefined {
	const lowerPath = path.toLowerCase();
	if (/\.(?:webm|mp4)$/.test(lowerPath)) return "recording";
	if (/\.(?:png|jpe?g|webp|gif)$/.test(lowerPath)) return "screenshot";
	const lowerLine = line.toLowerCase();
	if (lowerLine.includes("screenshot")) return "screenshot";
	if (/\b(?:screen\s+recording|recording|webm|video)\b/.test(lowerLine)) return "recording";
	return undefined;
}

function extractPromptRequestedArtifacts(prompt: string): PromptRequestedArtifact[] {
	const artifacts: PromptRequestedArtifact[] = [];
	const seen = new Set<string>();
	let fenceMarker: "`" | "~" | undefined;
	for (const line of prompt.split(/\r?\n/)) {
		const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]?.[0] as "`" | "~";
			if (!fenceMarker) fenceMarker = marker;
			else if (fenceMarker === marker) fenceMarker = undefined;
			continue;
		}
		if (fenceMarker || INSTRUCTIONAL_ARTIFACT_LINE_PATTERN.test(line)) continue;

		PROMPT_ARTIFACT_PATH_PATTERN.lastIndex = 0;
		for (const match of line.matchAll(PROMPT_ARTIFACT_PATH_PATTERN)) {
			const path = match[1]?.trim();
			if (!path || /^[~$]/.test(path) || /[<>{}\[\]]|\/api\/files\//i.test(path)) continue;
			const pathEnd = (match.index ?? 0) + match[0].indexOf(path) + path.length;
			if (!PROMPT_ARTIFACT_REQUEST_PATTERN.test(line.slice(0, pathEnd))) continue;
			const kind = inferPromptArtifactKind(line, path);
			if (!kind) continue;
			const key = `${kind}:${path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			artifacts.push({
				kind,
				path,
				required: kind === "screenshot" || !/\b(?:if|when)\s+(?:recording\s+)?(?:is\s+)?available\b/i.test(line),
			});
		}
	}
	return artifacts;
}

export function buildPromptPolicy(prompt: string): PromptPolicy {
	return {
		allowLegacyAgentBrowserBash: LEGACY_BASH_ALLOW_PATTERNS.some((pattern) => pattern.test(prompt)),
		requestedArtifacts: extractPromptRequestedArtifacts(prompt),
	};
}

function getMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((item) => {
			if (typeof item !== "object" || item === null) return "";
			return item.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

export function shouldAppendBrowserSystemPrompt(prompt: string): boolean {
	const normalizedPrompt = prompt.trim();
	if (normalizedPrompt.length === 0) {
		return false;
	}
	return BROWSER_PROMPT_PATTERNS.some((pattern) => pattern.test(normalizedPrompt));
}

export function getLatestUserPrompt(branch: unknown[]): string {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message") {
			continue;
		}
		const message = "message" in entry ? entry.message : undefined;
		if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "user") {
			continue;
		}
		return getMessageText("content" in message ? message.content : undefined);
	}
	return "";
}
