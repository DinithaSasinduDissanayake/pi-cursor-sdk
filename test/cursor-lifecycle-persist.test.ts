import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { CursorPartialContentEmitter } from "../src/cursor-partial-content-emitter.js";
import {
	collectEvents,
	collectThinkingDeltas,
	getDoneEvent,
	mockCreatedAgent,
	makeContext,
	makeModel,
	resetCursorProviderTestState,
	asMockCursorRun,
	type CursorDeltaHandler,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { CURSOR_TOOL_LIFECYCLE_DEFER_MS } from "../src/cursor-tool-lifecycle.js";

const delayBeyondLifecycleDefer = () =>
	new Promise((resolve) => setTimeout(resolve, CURSOR_TOOL_LIFECYCLE_DEFER_MS + 80));

function getThinkingBlocks(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking")
		.map((block) => block.thinking)
		.join("");
}

describe("cursor lifecycle persist", () => {
	const originalLifecyclePersist = process.env.PI_CURSOR_LIFECYCLE_PERSIST;

	afterEach(() => {
		if (originalLifecyclePersist === undefined) delete process.env.PI_CURSOR_LIFECYCLE_PERSIST;
		else process.env.PI_CURSOR_LIFECYCLE_PERSIST = originalLifecyclePersist;
	});

	describe("CursorPartialContentEmitter ephemeral thinking", () => {
		it("streams ephemeral thinking without mutating partial content", () => {
			const events: unknown[] = [];
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "cursor",
				provider: "cursor",
				model: "composer-2-5",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 1,
			};
			const stream = {
				push: (event: unknown) => events.push(event),
			};
			const emitter = new CursorPartialContentEmitter(stream as never, partial);

			emitter.appendEphemeralThinkingDelta("Cursor shell: npm test\n");
			emitter.closeEphemeralThinking();

			expect(collectThinkingDeltas(events as never)).toContain("Cursor shell: npm test");
			expect(partial.content).toEqual([]);
		});

		it("persists model thinking after ephemeral lifecycle trace", () => {
			const events: unknown[] = [];
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "cursor",
				provider: "cursor",
				model: "composer-2-5",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 1,
			};
			const stream = {
				push: (event: unknown) => events.push(event),
			};
			const emitter = new CursorPartialContentEmitter(stream as never, partial);

			emitter.appendEphemeralThinkingDelta("Cursor shell: npm test\n");
			emitter.appendThinkingDelta("real model thought");
			emitter.closeThinking();

			expect(getThinkingBlocks(partial)).toBe("real model thought");
			expect(getThinkingBlocks(partial)).not.toContain("Cursor shell");
		});
	});

	describe("streamCursor lifecycle persistence", () => {
		beforeEach(() => {
			delete process.env.PI_CURSOR_LIFECYCLE_PERSIST;
			resetCursorProviderTestState();
		});

		it("shows lifecycle progress live but omits it from persisted assistant content by default", async () => {
			process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
			const shellCall = { name: "shell", args: { command: "npm test" } };
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: shellCall, callId: "shell-1" } });
				await delayBeyondLifecycleDefer();
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							...shellCall,
							result: { status: "success", value: { stdout: "ok\n", stderr: "", exitCode: 0 } },
						},
						callId: "shell-1",
					},
				});
				opts.onDelta({ update: { type: "text-delta", text: "done" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const done = getDoneEvent(events);

			expect(collectThinkingDeltas(events)).toContain("Cursor shell: npm test");
			expect(getThinkingBlocks(done.message)).not.toMatch(/Cursor shell: npm test/);
		});

		it("still persists model thinking-delta output", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "thinking-delta", text: "model reasoning" } });
				opts.onDelta({ update: { type: "thinking-completed" } });
				opts.onDelta({ update: { type: "text-delta", text: "answer" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const done = getDoneEvent(events);

			expect(collectThinkingDeltas(events)).toContain("model reasoning");
			expect(getThinkingBlocks(done.message)).toBe("model reasoning");
		});

		it("restores lifecycle persistence when PI_CURSOR_LIFECYCLE_PERSIST=1", async () => {
			process.env.PI_CURSOR_LIFECYCLE_PERSIST = "1";
			process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
			const shellCall = { name: "shell", args: { command: "npm test" } };
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "tool-call-started", toolCall: shellCall, callId: "shell-1" } });
				await delayBeyondLifecycleDefer();
				opts.onDelta({
					update: {
						type: "tool-call-completed",
						toolCall: {
							...shellCall,
							result: { status: "success", value: { stdout: "ok\n", stderr: "", exitCode: 0 } },
						},
						callId: "shell-1",
					},
				});
				opts.onDelta({ update: { type: "text-delta", text: "done" } });
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const done = getDoneEvent(events);

			expect(getThinkingBlocks(done.message)).toMatch(/Cursor shell: npm test/);
		});

		it("keeps incomplete-tool trace cards in persisted content while omitting lifecycle progress", async () => {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({
					update: { type: "tool-call-started", toolCall: { name: "shell", args: { command: "sleep 10" } }, callId: "c1" },
				});
				await delayBeyondLifecycleDefer();
				return asMockCursorRun({
					id: "run-1",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({
				send: mockSend,
				[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
			});

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			const done = getDoneEvent(events);

			expect(collectThinkingDeltas(events)).toMatch(/Cursor shell: sleep 10/);
			expect(collectThinkingDeltas(events)).toContain("Cursor shell did not complete");
			expect(getThinkingBlocks(done.message)).toContain("Cursor shell did not complete");
			expect(getThinkingBlocks(done.message)).not.toMatch(/Cursor shell: sleep 10/);
		});
	});
});
