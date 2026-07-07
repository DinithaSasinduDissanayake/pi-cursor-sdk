import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context, Message } from "@earendil-works/pi-ai/compat";
import { buildCursorPrompt } from "../src/context.js";
import { CURSOR_TRANSCRIPT_CLOSE_TAG, CURSOR_TRANSCRIPT_OPEN_TAG } from "../src/context.js";
import {
	CURSOR_RETRY_AFTER_ABORT_MARKER,
	shouldApplyRetryAfterAbortMarker,
} from "../src/cursor-retry-marker.js";
import { isCursorTranscriptLeakLine } from "../src/cursor-transcript-leak-guard.js";

const SESSION_PATH = join(
	homedir(),
	".pi/agent/sessions/--home-sasindu--/2026-07-06T18-31-16-478Z_019f38b2-e6fe-7142-9e95-3b1e1fc2630e.jsonl",
);

function loadMessagesUpTo(jsonlPath: string, maxIndex: number): Message[] {
	const lines = readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
	const messages: Message[] = [];
	for (let index = 0; index <= maxIndex && index < lines.length; index += 1) {
		const entry = JSON.parse(lines[index]) as { message?: Message };
		if (entry.message) messages.push(entry.message);
	}
	return messages;
}

describe("realistic failing session reconstruction", () => {
	it("builds sane bootstrap prompt through message index 286 and detects MSG 287 leak lines", () => {
		const messages = loadMessagesUpTo(SESSION_PATH, 286);
		expect(messages.length).toBeGreaterThan(200);
		expect(shouldApplyRetryAfterAbortMarker(messages)).toBe(true);

		const prompt = buildCursorPrompt({ messages });
		const openIndex = prompt.text.indexOf(CURSOR_TRANSCRIPT_OPEN_TAG);
		const closeIndex = prompt.text.indexOf(CURSOR_TRANSCRIPT_CLOSE_TAG);
		expect(openIndex).toBeGreaterThan(-1);
		expect(closeIndex).toBeGreaterThan(openIndex);
		expect(prompt.text).toContain(CURSOR_RETRY_AFTER_ABORT_MARKER);

		const leakedSample =
			'[ran tool read (call cursor-replay-1783441805760-4-tool-19) args {"path":"voice-assistant/voice_assistant_lazy.py"} — historical record, not callable syntax]';
		expect(isCursorTranscriptLeakLine(leakedSample)).toBe(true);
	});
});
