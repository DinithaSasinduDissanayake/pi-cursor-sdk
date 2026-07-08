import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { CursorSdkTurnCoordinator } from "../src/cursor-provider-turn-coordinator.js";
import { CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX } from "../src/cursor-transcript-leak-guard.js";
import { collectTextDeltas } from "./helpers/cursor-provider-harness.js";
import { collectAssistantEvents, makeAssistantMessage } from "./helpers/pi-harness.js";

function makeCoordinator(stream = createAssistantMessageEventStream()) {
	return new CursorSdkTurnCoordinator({
		stream,
		partial: makeAssistantMessage(""),
		cwd: process.cwd(),
		useNativeToolReplay: false,
		nativeReplayId: "replay-1",
		textDeltas: [],
	});
}

describe("CursorSdkTurnCoordinator leak guard finalization", () => {
	it("closeTraceBlock then flushText still suppresses leaked finalText", async () => {
		const stream = createAssistantMessageEventStream();
		const coordinator = makeCoordinator(stream);
		const leaked =
			'[ran tool read (call cursor-replay-1) args {"path":"a"} — historical record, not callable syntax]\n';

		coordinator.closeTraceBlock();
		coordinator.flushText([leaked]);

		stream.end();
		const events = await collectAssistantEvents(stream);
		const text = collectTextDeltas(events);
		expect(text).not.toContain("[ran tool");
		expect(text).toContain(CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX);
	});

	it("finalizeTurnLeakGuard emits suppression notice on cancelled paths without flushText", async () => {
		const stream = createAssistantMessageEventStream();
		const coordinator = makeCoordinator(stream);
		const leaked =
			'[ran tool read (call cursor-replay-1) args {"path":"a"} — historical record, not callable syntax]\n';

		coordinator.handleDelta({ type: "text-delta", text: leaked });
		coordinator.closeTraceBlock();
		coordinator.finalizeTurnLeakGuard();

		stream.end();
		const events = await collectAssistantEvents(stream);
		const text = collectTextDeltas(events);
		expect(text).not.toContain("[ran tool");
		expect(text).toContain(CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX);
	});

	it("finalizeTurnLeakGuard emits notice to stream when liveRun is disposed", async () => {
		const stream = createAssistantMessageEventStream();
		const coordinator = new CursorSdkTurnCoordinator({
			stream,
			partial: makeAssistantMessage(""),
			cwd: process.cwd(),
			useNativeToolReplay: true,
			nativeReplayId: "replay-abort",
			textDeltas: [],
			liveRun: { disposed: true } as never,
		});
		const leaked =
			'[ran tool read (call cursor-replay-1) args {"path":"a"} — historical record, not callable syntax]\n';

		coordinator.handleDelta({ type: "text-delta", text: leaked });
		coordinator.closeTraceBlock();
		coordinator.finalizeTurnLeakGuard();

		stream.end();
		const events = await collectAssistantEvents(stream);
		const text = collectTextDeltas(events);
		expect(text).not.toContain("[ran tool");
		expect(text).toContain(CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX);
	});
});
