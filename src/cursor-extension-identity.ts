import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { CURSOR_SDK_EVENT_DEBUG_ENV, CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX } from "./cursor-sdk-event-debug-constants.js";

const require = createRequire(import.meta.url);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(moduleDir, "..");

export interface CursorExtensionIdentity {
	version: string;
	gitSha?: string;
}

export function resolveCursorExtensionIdentity(): CursorExtensionIdentity {
	const { version } = require(join(packageRoot, "package.json")) as { version: string };
	let gitSha: string | undefined;
	try {
		gitSha = execSync("git rev-parse --short HEAD", { cwd: packageRoot, encoding: "utf8" }).trim() || undefined;
	} catch {
		gitSha = undefined;
	}
	return { version, gitSha };
}

export function formatCursorExtensionIdentityLine(identity: CursorExtensionIdentity = resolveCursorExtensionIdentity()): string {
	const suffix = identity.gitSha ? ` @ ${identity.gitSha}` : "";
	return `pi-cursor-sdk ${identity.version}${suffix}`;
}

export function logCursorExtensionIdentity(env: Record<string, string | undefined> = process.env): void {
	const line = formatCursorExtensionIdentityLine(resolveCursorExtensionIdentity());
	console.info(line);
	if (parseEnvBoolean(env[CURSOR_SDK_EVENT_DEBUG_ENV], false)) {
		console.info(`${CURSOR_SDK_EVENT_DEBUG_LOG_PREFIX} ${line}`);
	}
}
