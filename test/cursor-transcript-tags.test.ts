import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai/compat";
import {
	buildCursorPrompt,
	buildCursorIncrementalPrompt,
	CURSOR_TRANSCRIPT_CLOSE_TAG,
	CURSOR_TRANSCRIPT_OPEN_TAG,
	CURSOR_TRANSCRIPT_PREAMBLE,
} from "../src/context.js";
import { CURSOR_TRANSCRIPT_TAGS_ENV } from "../src/cursor-leak-fix-env.js";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("bootstrap transcript delimiters", () => {
	const originalEnv = process.env[CURSOR_TRANSCRIPT_TAGS_ENV];

	beforeEach(() => {
		delete process.env[CURSOR_TRANSCRIPT_TAGS_ENV];
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env[CURSOR_TRANSCRIPT_TAGS_ENV];
		else process.env[CURSOR_TRANSCRIPT_TAGS_ENV] = originalEnv;
	});

	it("wraps history inside transcript tags and keeps latest user outside", () => {
		const ctx = {
			messages: [
				{ role: "user", content: "old request", timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [{ type: "text", text: "old answer" }],
					api: "cursor-sdk",
					provider: "cursor",
					model: "test",
					usage,
					stopReason: "stop",
					timestamp: 2,
				} satisfies AssistantMessage,
				{ role: "user", content: "latest request", timestamp: 3 } satisfies UserMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain(CURSOR_TRANSCRIPT_PREAMBLE);
		expect((result.text.match(new RegExp(CURSOR_TRANSCRIPT_OPEN_TAG, "g")) ?? []).length).toBe(1);
		expect((result.text.match(new RegExp(CURSOR_TRANSCRIPT_CLOSE_TAG, "g")) ?? []).length).toBe(1);
		const openIndex = result.text.indexOf(CURSOR_TRANSCRIPT_OPEN_TAG);
		const closeIndex = result.text.indexOf(CURSOR_TRANSCRIPT_CLOSE_TAG);
		const latestIndex = result.text.indexOf("User: latest request");
		expect(openIndex).toBeGreaterThan(-1);
		expect(closeIndex).toBeGreaterThan(openIndex);
		expect(latestIndex).toBeGreaterThan(closeIndex);
		expect(result.text.slice(openIndex, closeIndex)).toContain("User: old request");
		expect(result.text.slice(openIndex, closeIndex)).toContain("Assistant: old answer");
	});

	it("does not wrap incremental prompts", () => {
		const ctx = {
			messages: [{ role: "user", content: "latest only", timestamp: 1 } satisfies UserMessage],
		};
		const result = buildCursorIncrementalPrompt(ctx);
		expect(result.text).not.toContain(CURSOR_TRANSCRIPT_OPEN_TAG);
	});

	it("places budget notice inside transcript tags", () => {
		const ctx = {
			messages: [
				{ role: "user", content: `old request ${"x".repeat(200)}`, timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [{ type: "text", text: `old answer ${"y".repeat(200)}` }],
					api: "cursor-sdk",
					provider: "cursor",
					model: "test",
					usage,
					stopReason: "stop",
					timestamp: 2,
				} satisfies AssistantMessage,
				{ role: "user", content: "latest request must stay", timestamp: 3 } satisfies UserMessage,
			],
		};
		const result = buildCursorPrompt(ctx, { maxInputTokens: 120, charsPerToken: 1 });
		const notice = "[Earlier transcript omitted: 2 messages to fit Cursor context budget]";
		expect(result.text).toContain(notice);
		const openIndex = result.text.indexOf(CURSOR_TRANSCRIPT_OPEN_TAG);
		const closeIndex = result.text.indexOf(CURSOR_TRANSCRIPT_CLOSE_TAG);
		const noticeIndex = result.text.indexOf(notice);
		expect(noticeIndex).toBeGreaterThan(openIndex);
		expect(noticeIndex).toBeLessThan(closeIndex);
		expect(result.text).toContain("User: latest request must stay");
	});

	it("respects PI_CURSOR_TRANSCRIPT_TAGS=0", () => {
		process.env[CURSOR_TRANSCRIPT_TAGS_ENV] = "0";
		const ctx = {
			messages: [
				{ role: "user", content: "old", timestamp: 1 } satisfies UserMessage,
				{ role: "user", content: "latest", timestamp: 2 } satisfies UserMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		expect(result.text).not.toContain(CURSOR_TRANSCRIPT_OPEN_TAG);
	});

	it("keeps tool results inside transcript history", () => {
		const ctx = {
			messages: [
				{ role: "user", content: "run", timestamp: 1 } satisfies UserMessage,
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "bash",
					content: [{ type: "text", text: "output" }],
					isError: false,
					timestamp: 2,
				} satisfies ToolResultMessage,
				{ role: "user", content: "latest", timestamp: 3 } satisfies UserMessage,
			],
		};
		const result = buildCursorPrompt(ctx);
		const openIndex = result.text.indexOf(CURSOR_TRANSCRIPT_OPEN_TAG);
		const closeIndex = result.text.indexOf(CURSOR_TRANSCRIPT_CLOSE_TAG);
		expect(result.text.slice(openIndex, closeIndex)).toContain("Tool result (bash, call tc1): output");
	});
});
