import type { SDKAgent } from "@cursor/sdk";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX,
	CursorTranscriptLeakGuard,
	formatCursorTranscriptLeakSuppressionNotice,
} from "../src/cursor-transcript-leak-guard.js";
import { drainCursorLiveRunTurn, cursorLiveRuns } from "../src/cursor-provider-live-run-drain.js";
import { CursorSdkTurnCoordinator } from "../src/cursor-provider-turn-coordinator.js";
import {
	collectEvents,
	collectTextDeltas,
	makeContext,
	makeModel,
	resetCursorProviderTestState,
	type CursorDeltaHandler,
	mockCreatedAgent,
	asMockCursorRun,
	registerNativeToolDisplayForTest,
} from "./helpers/cursor-provider-harness.js";
import { collectAssistantEvents, makeAssistantMessage } from "./helpers/pi-harness.js";
import { streamCursor } from "../src/cursor-provider.js";

const CANONICAL_LEAKED_FINAL_TEXT =
	'[ran tool read (call cursor-replay-1) args {"path":"a"} — historical record, not callable syntax]\n' +
	"Tool result (read, call cursor-replay-1): snippet\n";

describe("drainCursorLiveRunTurn finalText leak guard", () => {
	beforeEach(resetCursorProviderTestState);

	it("suppresses leaked finalText when streamed deltas are empty", async () => {
		const stream = createAssistantMessageEventStream();
		const partial = makeAssistantMessage("");
		const agent = { agentId: "agent-1" } as SDKAgent;
		const run = cursorLiveRuns.start({
			id: "cursor-replay-1",
			agent,
			promptInputTokens: 0,
		});
		const coordinator = new CursorSdkTurnCoordinator({
			stream,
			partial,
			cwd: process.cwd(),
			useNativeToolReplay: true,
			nativeReplayId: "cursor-replay-1",
			textDeltas: [],
			liveRun: run,
		});
		cursorLiveRuns.markFinished(run, CANONICAL_LEAKED_FINAL_TEXT);

		const outcome = await drainCursorLiveRunTurn(stream, partial, makeModel(), makeContext(), run, 0, {
			mode: "emit",
			transcriptLeakGuard: coordinator.getTranscriptLeakGuard(),
		});

		stream.end();
		const text = collectTextDeltas(await collectAssistantEvents(stream));
		expect(outcome).toBe("stop");
		expect(text).not.toContain("[ran tool");
		expect(text).not.toContain("historical record");
		expect(text).toContain(CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX);
	});

	it("passes clean finalText through byte-for-byte", async () => {
		const stream = createAssistantMessageEventStream();
		const partial = makeAssistantMessage("");
		const agent = { agentId: "agent-1" } as SDKAgent;
		const run = cursorLiveRuns.start({
			id: "cursor-replay-2",
			agent,
			promptInputTokens: 0,
		});
		const clean = "Final answer only.\n";
		const guard = new CursorTranscriptLeakGuard(true);
		cursorLiveRuns.markFinished(run, clean);

		await drainCursorLiveRunTurn(stream, partial, makeModel(), makeContext(), run, 0, {
			mode: "emit",
			transcriptLeakGuard: guard,
		});

		stream.end();
		const text = collectTextDeltas(await collectAssistantEvents(stream));
		expect(text).toBe(clean);
	});

	it("emits one suppression notice when leaks appear in both stream and finalText", async () => {
		const stream = createAssistantMessageEventStream();
		const partial = makeAssistantMessage("");
		const agent = { agentId: "agent-1" } as SDKAgent;
		const run = cursorLiveRuns.start({
			id: "cursor-replay-3",
			agent,
			promptInputTokens: 0,
		});
		const coordinator = new CursorSdkTurnCoordinator({
			stream,
			partial,
			cwd: process.cwd(),
			useNativeToolReplay: true,
			nativeReplayId: "cursor-replay-3",
			textDeltas: [],
			liveRun: run,
		});
		const streamedLeak =
			'[ran tool bash (call cursor-replay-3) args {"command":"ls"} — historical record, not callable syntax]\n';
		coordinator.handleDelta({ type: "text-delta", text: streamedLeak });
		cursorLiveRuns.markFinished(run, CANONICAL_LEAKED_FINAL_TEXT);

		await drainCursorLiveRunTurn(stream, partial, makeModel(), makeContext(), run, 0, {
			mode: "emit",
			transcriptLeakGuard: coordinator.getTranscriptLeakGuard(),
		});

		stream.end();
		const text = collectTextDeltas(await collectAssistantEvents(stream));
		const noticeMatches = text.match(
			new RegExp(CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\d+", "g"),
		);
		expect(text).not.toContain("[ran tool");
		expect(noticeMatches).toHaveLength(1);
		expect(text).toContain(formatCursorTranscriptLeakSuppressionNotice(3));
	});

	it("dedupes standalone drain notices when streaming already emitted one", async () => {
		const stream = createAssistantMessageEventStream();
		const partial = makeAssistantMessage("");
		const agent = { agentId: "agent-1" } as SDKAgent;
		const run = cursorLiveRuns.start({
			id: "cursor-replay-4",
			agent,
			promptInputTokens: 0,
		});
		const notice = formatCursorTranscriptLeakSuppressionNotice(1);
		cursorLiveRuns.queueEvent(run, { type: "text-delta", text: notice });
		run.emittedText = notice;
		cursorLiveRuns.markFinished(run, CANONICAL_LEAKED_FINAL_TEXT);

		await drainCursorLiveRunTurn(stream, partial, makeModel(), makeContext(), run, 0, {
			mode: "emit",
		});

		stream.end();
		const text = collectTextDeltas(await collectAssistantEvents(stream));
		const noticeMatches = text.match(
			new RegExp(CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\d+", "g"),
		);
		expect(text).not.toContain("[ran tool");
		expect(noticeMatches).toHaveLength(1);
	});
});

describe("streamCursor live run finalText leak guard", () => {
	beforeEach(resetCursorProviderTestState);

	it("suppresses leaked text that arrives only via wait result on native replay stop turns", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await registerNativeToolDisplayForTest([]);

		const mockSend = vi.fn().mockImplementation(async () => {
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "running",
				wait: vi.fn().mockResolvedValue({
					id: "run-1",
					status: "finished",
					result: CANONICAL_LEAKED_FINAL_TEXT,
				}),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			agentId: "agent-1",
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const text = collectTextDeltas(events);
		const done = events.find((event) => event.type === "done");

		expect(done?.reason).toBe("stop");
		expect(text).not.toContain("[ran tool");
		expect(text).not.toContain("historical record");
		expect(text).toContain(CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX);
	});
});
