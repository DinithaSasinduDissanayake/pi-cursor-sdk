import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai/compat";
import {
	buildCursorPrompt,
	buildCursorIncrementalPrompt,
} from "../src/context.js";
import { CURSOR_RETRY_MARKER_ENV } from "../src/cursor-leak-fix-env.js";
import {
	shouldApplyRetryAfterAbortMarker,
	isFailedAssistantTurn,
	CURSOR_RETRY_AFTER_ABORT_MARKER,
} from "../src/cursor-retry-marker.js";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("retry-after-abort marker", () => {
	const originalEnv = process.env[CURSOR_RETRY_MARKER_ENV];

	beforeEach(() => {
		delete process.env[CURSOR_RETRY_MARKER_ENV];
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env[CURSOR_RETRY_MARKER_ENV];
		else process.env[CURSOR_RETRY_MARKER_ENV] = originalEnv;
	});

	it("detects aborted empty assistant turns", () => {
		const msg = {
			role: "assistant",
			content: [],
			api: "cursor-sdk",
			provider: "cursor",
			model: "test",
			usage,
			stopReason: "aborted",
			timestamp: 1,
		} satisfies AssistantMessage;
		expect(isFailedAssistantTurn(msg)).toBe(true);
	});

	it("adds marker after aborted empty assistant with identical user resend (bootstrap)", () => {
		const request = "Task: two small fixes + one retest. Then commit.";
		const ctx = {
			messages: [
				{ role: "user", content: request, timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [],
					api: "cursor-sdk",
					provider: "cursor",
					model: "test",
					usage,
					stopReason: "aborted",
					timestamp: 2,
				} satisfies AssistantMessage,
				{ role: "user", content: request, timestamp: 3 } satisfies UserMessage,
			],
		};
		expect(shouldApplyRetryAfterAbortMarker(ctx.messages)).toBe(true);
		const result = buildCursorPrompt(ctx);
		expect(result.text).toContain(CURSOR_RETRY_AFTER_ABORT_MARKER);
		expect(result.text).toContain(`User: ${CURSOR_RETRY_AFTER_ABORT_MARKER}\n${request}`);
	});

	it("adds marker on incremental prompt for identical resend after abort", () => {
		const request = "Retry me";
		const ctx = {
			messages: [
				{ role: "user", content: request, timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [],
					api: "cursor-sdk",
					provider: "cursor",
					model: "test",
					usage,
					stopReason: "aborted",
					timestamp: 2,
				} satisfies AssistantMessage,
				{ role: "user", content: request, timestamp: 3 } satisfies UserMessage,
			],
		};
		const result = buildCursorIncrementalPrompt(ctx);
		expect(result.text).toContain(CURSOR_RETRY_AFTER_ABORT_MARKER);
	});

	it("does not add marker when prior assistant completed normally", () => {
		const request = "Same request";
		const ctx = {
			messages: [
				{ role: "user", content: request, timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [{ type: "text", text: "Done." }],
					api: "cursor-sdk",
					provider: "cursor",
					model: "test",
					usage,
					stopReason: "stop",
					timestamp: 2,
				} satisfies AssistantMessage,
				{ role: "user", content: request, timestamp: 3 } satisfies UserMessage,
			],
		};
		expect(shouldApplyRetryAfterAbortMarker(ctx.messages)).toBe(false);
		const result = buildCursorPrompt(ctx);
		expect(result.text).not.toContain(CURSOR_RETRY_AFTER_ABORT_MARKER);
		expect(result.text).toContain(`User: ${request}`);
	});

	it("does not add marker when resend text differs after abort", () => {
		const ctx = {
			messages: [
				{ role: "user", content: "first", timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [],
					api: "cursor-sdk",
					provider: "cursor",
					model: "test",
					usage,
					stopReason: "aborted",
					timestamp: 2,
				} satisfies AssistantMessage,
				{ role: "user", content: "second", timestamp: 3 } satisfies UserMessage,
			],
		};
		expect(shouldApplyRetryAfterAbortMarker(ctx.messages)).toBe(false);
	});

	it("respects PI_CURSOR_RETRY_MARKER=0", () => {
		process.env[CURSOR_RETRY_MARKER_ENV] = "0";
		const request = "Task";
		const ctx = {
			messages: [
				{ role: "user", content: request, timestamp: 1 } satisfies UserMessage,
				{
					role: "assistant",
					content: [],
					api: "cursor-sdk",
					provider: "cursor",
					model: "test",
					usage,
					stopReason: "aborted",
					timestamp: 2,
				} satisfies AssistantMessage,
				{ role: "user", content: request, timestamp: 3 } satisfies UserMessage,
			],
		};
		expect(shouldApplyRetryAfterAbortMarker(ctx.messages)).toBe(false);
	});
});
