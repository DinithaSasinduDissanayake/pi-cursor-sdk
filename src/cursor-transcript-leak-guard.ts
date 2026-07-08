import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import { resolveCursorLeakGuardEnabled } from "./cursor-leak-fix-env.js";

export const CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX =
	"[pi-cursor-sdk: suppressed ";

export const CURSOR_TRANSCRIPT_LEAK_LINE_PATTERNS: readonly RegExp[] = [
	/^\s*\[ran tool\b/,
	/^\s*\[ran tool \S+ \(call cursor-replay-/,
	/^\s*\[ran tool .+ (historical record|result pruned)/,
	/^\s*Tool (result|error) \([^)]*call cursor-replay-/,
	/^\s*Assistant: \[ran tool/,
];

const LINE_BUFFER_CAP_CHARS = 500;
const LOOSE_BLOCK_MAX_LINES = 20;
const INCOMPLETE_LEAK_PREFIXES = ["[ran tool", "Tool result (", "Tool error (", "Assistant: [ran tool"] as const;
const LEAK_ARG_KEY_LINES = new Set(["command", "description", "path"]);
const BARE_CURSOR_TOOL_NAME_LINES = new Set([
	"Read",
	"Shell",
	"Grep",
	"Glob",
	"Write",
	"Edit",
	"Delete",
	"Task",
	"SemanticSearch",
	"WebSearch",
	"WebFetch",
	"CreatePlan",
	"RecordScreen",
]);

export function isCursorTranscriptLeakLine(line: string): boolean {
	return CURSOR_TRANSCRIPT_LEAK_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

export function isIncompleteLooseRanToolLine(line: string): boolean {
	return (
		/^\s*\[ran tool\b/.test(line) &&
		!/\(call cursor-replay-|historical record|result pruned/.test(line)
	);
}

export function couldBeIncompleteLeakPrefix(text: string): boolean {
	if (!text) return false;
	const normalized = text.replace(/^\s+/, "");
	for (const prefix of INCOMPLETE_LEAK_PREFIXES) {
		if (prefix.startsWith(normalized) || normalized.startsWith(prefix)) return true;
	}
	return false;
}

export function formatCursorTranscriptLeakSuppressionNotice(suppressedLineCount: number): string {
	const noun = suppressedLineCount === 1 ? "line" : "lines";
	return `${CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX}${suppressedLineCount} ${noun} of leaked transcript-format output from the model]\n`;
}

function isLeakContinuationLine(trimmed: string): boolean {
	return LEAK_ARG_KEY_LINES.has(trimmed) || BARE_CURSOR_TOOL_NAME_LINES.has(trimmed);
}

function looksLikeNormalProse(trimmed: string): boolean {
	if (!trimmed) return false;
	const words = trimmed.split(/\s+/);
	return words.length >= 8 && /[a-z]/.test(trimmed) && /[.!?]$/.test(trimmed);
}

export class CursorTranscriptLeakGuard {
	private lineBuffer = "";
	private atLineStart = true;
	private leakDetected = false;
	private looseBlockActive = false;
	private looseBlockLinesRemaining = 0;
	private suppressedLineCount = 0;
	private suppressedText = "";
	private finalized = false;

	constructor(
		private readonly enabled = resolveCursorLeakGuardEnabled(),
		private readonly debugRecorder?: CursorSdkEventDebugRecorder,
	) {}

	processDelta(delta: string): string[] {
		if (!this.enabled || !delta || this.finalized) return delta ? [delta] : [];
		this.lineBuffer += delta;
		return this.drainCompleteLines(false);
	}

	finalizeAtTurnEnd(): { notice?: string; tail: string[] } {
		if (!this.enabled || this.finalized) return { tail: [] };
		this.finalized = true;
		const tail = this.drainCompleteLines(true);
		if (this.suppressedLineCount <= 0) return { tail };
		this.debugRecorder?.recordCoordinatorEvent("transcript-leak-guard-suppressed", {
			suppressedLineCount: this.suppressedLineCount,
			suppressedText: this.suppressedText,
		});
		return {
			notice: formatCursorTranscriptLeakSuppressionNotice(this.suppressedLineCount),
			tail,
		};
	}

	private drainCompleteLines(flushPartial: boolean): string[] {
		const forwarded: string[] = [];
		while (true) {
			const newlineIndex = this.lineBuffer.indexOf("\n");
			if (newlineIndex >= 0) {
				const line = this.lineBuffer.slice(0, newlineIndex + 1);
				this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
				forwarded.push(...this.handleLine(line, this.atLineStart));
				this.atLineStart = true;
				continue;
			}
			if (this.lineBuffer.length > LINE_BUFFER_CAP_CHARS) {
				forwarded.push(...this.handleLine(this.lineBuffer, this.atLineStart));
				this.lineBuffer = "";
				this.atLineStart = false;
				continue;
			}
			if (flushPartial && this.lineBuffer) {
				forwarded.push(...this.handleLine(this.lineBuffer, this.atLineStart));
				this.lineBuffer = "";
				break;
			}
			if (this.lineBuffer && !couldBeIncompleteLeakPrefix(this.lineBuffer)) {
				forwarded.push(...this.handleLine(this.lineBuffer, this.atLineStart));
				this.lineBuffer = "";
				this.atLineStart = false;
			}
			break;
		}
		return forwarded;
	}

	private handleLine(line: string, atLineStart: boolean): string[] {
		const trimmed = line.trim();

		if (this.looseBlockActive) {
			if (looksLikeNormalProse(trimmed)) {
				this.looseBlockActive = false;
				return [line];
			}
			if (this.looseBlockLinesRemaining > 0) {
				this.looseBlockLinesRemaining -= 1;
				this.leakDetected = true;
				this.recordSuppressedLine(line);
				return [];
			}
			this.looseBlockActive = false;
		}

		if (atLineStart) {
			if (this.leakDetected && isLeakContinuationLine(trimmed)) {
				this.recordSuppressedLine(line);
				return [];
			}

			if (isIncompleteLooseRanToolLine(line)) {
				this.leakDetected = true;
				this.looseBlockActive = true;
				this.looseBlockLinesRemaining = LOOSE_BLOCK_MAX_LINES - 1;
				this.recordSuppressedLine(line);
				return [];
			}

			if (isCursorTranscriptLeakLine(line)) {
				this.leakDetected = true;
				this.recordSuppressedLine(line);
				return [];
			}
		}

		return [line];
	}

	private recordSuppressedLine(line: string): void {
		this.suppressedLineCount += 1;
		this.suppressedText += line;
	}
}
