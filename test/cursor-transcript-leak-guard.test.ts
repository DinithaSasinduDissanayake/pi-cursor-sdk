import { describe, it, expect } from "vitest";
import {
	CursorTranscriptLeakGuard,
	isCursorTranscriptLeakLine,
	formatCursorTranscriptLeakSuppressionNotice,
} from "../src/cursor-transcript-leak-guard.js";

describe("CursorTranscriptLeakGuard", () => {
	it("detects high-precision leak line patterns", () => {
		expect(
			isCursorTranscriptLeakLine(
				'[ran tool read (call cursor-replay-1) args {"path":"a"} — historical record, not callable syntax]',
			),
		).toBe(true);
		expect(isCursorTranscriptLeakLine("Tool result (read, call cursor-replay-1): body")).toBe(true);
		expect(isCursorTranscriptLeakLine("Assistant: [ran tool bash")).toBe(true);
		expect(isCursorTranscriptLeakLine("Assistant: hello")).toBe(false);
	});

	it("passes clean text through byte-for-byte", () => {
		const guard = new CursorTranscriptLeakGuard(true);
		const input = "Hello world.\nStill clean.\n";
		expect(guard.processDelta(input).join("")).toBe(input);
	});

	it("detects leak split across two deltas", () => {
		const guard = new CursorTranscriptLeakGuard(true);
		const part1 = "Prefix\n[ran tool read (call cursor-replay-9) args ";
		const part2 = '{"path":"x"} — historical record, not callable syntax]\n';
		expect(guard.processDelta(part1)).toEqual(["Prefix\n"]);
		expect(guard.processDelta(part2)).toEqual([]);
		const { notice, tail } = guard.finalizeAtTurnEnd();
		expect(notice).toBe(formatCursorTranscriptLeakSuppressionNotice(1));
		expect(tail).toEqual([]);
	});

	it("emits notice for full-leak turns with no clean output", () => {
		const guard = new CursorTranscriptLeakGuard(true);
		const leaked =
			'[ran tool read (call cursor-replay-1783441805760-4-tool-19) args {"path":"voice-assistant/voice_assistant_lazy.py"} — historical record, not callable syntax]\n' +
			"Tool result (read, call cursor-replay-1783441805760-4-tool-19): snippet\n";
		expect(guard.processDelta(leaked)).toEqual([]);
		const { notice } = guard.finalizeAtTurnEnd();
		expect(notice).toBe(formatCursorTranscriptLeakSuppressionNotice(2));
	});

	it("forwards non-matching lines after leak detection", () => {
		const guard = new CursorTranscriptLeakGuard(true);
		const leaked = "[ran tool bash (call cursor-replay-1) — historical record, not callable syntax]\n";
		const clean = "Here is the real answer.\n";
		guard.processDelta(leaked);
		expect(guard.processDelta(clean)).toEqual([clean]);
	});

	it("flushes oversized line buffer as clean when no newline arrives", () => {
		const guard = new CursorTranscriptLeakGuard(true);
		const chunk = "x".repeat(520);
		const forwarded = guard.processDelta(chunk);
		expect(forwarded.join("")).toBe(chunk);
		expect(guard.processDelta("tail")).toEqual(["tail"]);
	});

	it("matches MSG 287 leaked sample lines", () => {
		const sample =
			'[ran tool read (call cursor-replay-1783441805760-4-tool-19) args {"path":"voice-assistant/voice_assistant_lazy.py"} — historical record, not callable syntax]';
		expect(isCursorTranscriptLeakLine(sample)).toBe(true);
	});

	it("does not suppress leak-like text split mid-line across deltas", () => {
		const guard = new CursorTranscriptLeakGuard(true);
		const prefix = "I typed the ";
		const suffix = "[ran tool read (call cursor-replay-1) — historical record, not callable syntax]";
		expect(guard.processDelta(prefix)).toEqual([prefix]);
		expect(guard.processDelta(suffix)).toEqual([]);
		const { notice, tail } = guard.finalizeAtTurnEnd();
		expect(notice).toBeUndefined();
		expect(tail).toEqual([suffix]);
	});

	it("still suppresses genuine leak lines that start after a newline", () => {
		const guard = new CursorTranscriptLeakGuard(true);
		const clean = "I typed the following example.\n";
		const leaked = "[ran tool read (call cursor-replay-1) — historical record, not callable syntax]\n";
		expect(guard.processDelta(clean)).toEqual([clean]);
		expect(guard.processDelta(leaked)).toEqual([]);
		const { notice } = guard.finalizeAtTurnEnd();
		expect(notice).toBe(formatCursorTranscriptLeakSuppressionNotice(1));
	});
});
