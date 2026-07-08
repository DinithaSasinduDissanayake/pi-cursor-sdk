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

	it("suppresses long leak lines force-flushed before tail marker arrives", () => {
		const guard = new CursorTranscriptLeakGuard(true);
		const leakHead = '[ran tool write (call cursor-replay-1) args {"content":"';
		// No newline yet and >500 chars — cap flush fires before tail marker is seen.
		expect(guard.processDelta("Prefix\n")).toEqual(["Prefix\n"]);
		expect(guard.processDelta(leakHead + "a".repeat(500))).toEqual([]);
		const { notice, tail } = guard.finalizeAtTurnEnd();
		expect(notice).toBe(formatCursorTranscriptLeakSuppressionNotice(1));
		expect(tail).toEqual([]);
	});

	it("suppresses long leak lines with 1000-char args split across deltas", () => {
		const guard = new CursorTranscriptLeakGuard(true);
		const longArgs = "a".repeat(1000);
		const leakHead = '[ran tool write (call cursor-replay-1) args {"content":"';
		const leakTail = `${longArgs}"} — historical record, not callable syntax]\n`;
		expect(guard.processDelta("Prefix\n")).toEqual(["Prefix\n"]);
		expect(guard.processDelta(leakHead)).toEqual([]);
		expect(guard.processDelta(leakTail)).toEqual([]);
		const { notice, tail } = guard.finalizeAtTurnEnd();
		expect(notice).toBe(formatCursorTranscriptLeakSuppressionNotice(1));
		expect(tail).toEqual([]);
	});

	it("does not suppress prose that mentions [ran tool without cursor-replay token", () => {
		const guard = new CursorTranscriptLeakGuard(true);
		const prose = 'Docs say "[ran tool read" is not a real invocation.\n';
		expect(isCursorTranscriptLeakLine(prose.trimEnd())).toBe(false);
		expect(guard.processDelta(prose)).toEqual([prose]);
		const { notice } = guard.finalizeAtTurnEnd();
		expect(notice).toBeUndefined();
	});

	it("detects loose [ran tool line starts without call-id or historical marker", () => {
		expect(isCursorTranscriptLeakLine("[ran tool bash\n")).toBe(true);
		expect(isCursorTranscriptLeakLine("[ran tool read (call cursor-replay-1)")).toBe(true);
	});

	it("suppresses session 019f3e03 msg-277 loose leak variant with notice", () => {
		const guard = new CursorTranscriptLeakGuard(true);
		const prose =
			"Starting the bulk mirror approach to finish Phase 1 today.\n\n";
		const leaked = `[ran tool bash
command
cd "/home/sasindu/Documents/SLIIT Materials/Y4S1/research-project" && echo "=== Step 0: push ===" && git status && git push 2>&1
description
Push current branch and verify ahead count

Read
path
/home/sasindu/Documents/SLIIT Materials/Y4S1/research-project/scripts/fetch_fkie_cad_release.py

Shell
command
curl -sL "https://api.github.com/repos/fkie-cad/nvd-json-data-feeds/releases/latest" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['tag_name'], r['published_at'])"
description
Fetch latest fkie-cad release metadata
`;
		expect(guard.processDelta(prose).join("")).toContain("Starting the bulk mirror approach");
		expect(guard.processDelta(leaked)).toEqual([]);
		const { notice } = guard.finalizeAtTurnEnd();
		expect(notice).toMatch(/suppressed 1[0-9] lines/);
	});
});
