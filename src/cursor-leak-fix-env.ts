import { parseEnvBoolean } from "./cursor-env-boolean.js";

export const CURSOR_RETRY_MARKER_ENV = "PI_CURSOR_RETRY_MARKER";
export const CURSOR_TRANSCRIPT_TAGS_ENV = "PI_CURSOR_TRANSCRIPT_TAGS";
export const CURSOR_LEAK_GUARD_ENV = "PI_CURSOR_LEAK_GUARD";
export const CURSOR_LIFECYCLE_PERSIST_ENV = "PI_CURSOR_LIFECYCLE_PERSIST";

export function resolveCursorRetryMarkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_RETRY_MARKER_ENV], true);
}

export function resolveCursorTranscriptTagsEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_TRANSCRIPT_TAGS_ENV], true);
}

export function resolveCursorLeakGuardEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_LEAK_GUARD_ENV], true);
}

export function resolveCursorLifecyclePersistEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_LIFECYCLE_PERSIST_ENV], false);
}
