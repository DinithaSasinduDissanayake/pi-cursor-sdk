import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import { resolveCursorLeakGuardEnabled } from "./cursor-leak-fix-env.js";

export const CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX =
	"[pi-cursor-sdk: suppressed ";

export const CURSOR_TRANSCRIPT_LEAK_LINE_PATTERNS: readonly RegExp[] = [
	/^\s*\[ran tool\b/,
	/^\s*\[ran tool \S+ \(call cursor-replay-/,
	/^\s*\[ran tool .+ (historical record|result pruned)/,
	/^\s*Tool (result|error) \([^)]*call cursor-replay-/,
	/^\s*Tool (result|error) \([^,]+, call [\w-]{4,}\):/,
	/^\s*Assistant: \[ran tool/,
];

const LINE_BUFFER_CAP_CHARS = 500;
const LOOSE_BLOCK_MAX_LINES = 20;
const INCOMPLETE_LEAK_PREFIXES = ["[ran tool", "Tool result (", "Tool error (", "Assistant: [ran tool"] as const;
const LEAK_ARG_KEY_LINES = new Set(["command", "description", "path"]);
const BARE_CURSOR_TOOL_NAME_LINES = new Set([
	"Read", "Shell", "Grep", "Glob", "Write", "Edit", "Delete",
	"Task", "SemanticSearch", "WebSearch", "WebFetch", "CreatePlan", "RecordScreen",
]);

export function isCursorTranscriptLeakLine(line: string): boolean {
	return CURSOR_TRANSCRIPT_LEAK_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

export function isIncompleteLooseRanToolLine(line: string): boolean {
	return /^\s*\[ran tool\b/.test(line) && !/\(call cursor-replay-|historical record|result pruned/.test(line);
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

export function hasTranscriptLeakSuppressionNotice(text: string): boolean {
	return text.includes(CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX);
}

function isLeakContinuationLine(trimmed: string): boolean {
	return LEAK_ARG_KEY_LINES.has(trimmed) || BARE_CURSOR_TOOL_NAME_LINES.has(trimmed);
}

function looksLikeNormalProse(trimmed: string): boolean {
	if (!trimmed) return false;
	const words = trimmed.split(/\s+/);
	return words.length >= 8 && /[a-z]/.test(trimmed) && /[.!?]$/.test(trimmed);
}

function looksLikeLooseBlockContinuation(chunk: string): boolean {
	const trimmed = chunk.trim();
	if (trimmed === "") return true;
	if (isLeakContinuationLine(trimmed)) return true;
	if (isIncompleteLooseRanToolLine(chunk)) return true;
	if (isCursorTranscriptLeakLine(chunk)) return true;
	return false;
}

type Mode = "NORMAL" | "IN_LEAK_LINE" | "IN_LOOSE_BLOCK";

export class CursorTranscriptLeakGuard {
	private lineBuffer = "";
	private atLineStart = true;
	private leakDetected = false;
	private looseBlockLinesRemaining = 0;
	/** Each call to recordSuppressedLine() increments this; notice text uses this count. */
	private suppressedLineCount = 0;
	private suppressedText = "";
	private finalized = false;
	private mode: Mode = "NORMAL";
	private pendingLooseBlock = false;

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
				const chunk = this.lineBuffer.slice(0, newlineIndex + 1);
				this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
				forwarded.push(...this.processChunk(chunk, true, this.atLineStart));
				this.atLineStart = true;
				continue;
			}
			if (this.lineBuffer.length > LINE_BUFFER_CAP_CHARS) {
				const chunk = this.lineBuffer;
				this.lineBuffer = "";
				forwarded.push(...this.processChunk(chunk, false, this.atLineStart));
				this.atLineStart = false;
				continue;
			}
			if (flushPartial && this.lineBuffer) {
				const chunk = this.lineBuffer;
				this.lineBuffer = "";
				forwarded.push(...this.processChunk(chunk, false, this.atLineStart));
				break;
			}
			if (this.lineBuffer && !couldBeIncompleteLeakPrefix(this.lineBuffer)) {
				const chunk = this.lineBuffer;
				this.lineBuffer = "";
				forwarded.push(...this.processChunk(chunk, false, this.atLineStart));
				this.atLineStart = false;
			}
			break;
		}
		return forwarded;
	}

	private suppress(chunk: string): void {
		this.recordSuppressedLine(chunk);
	}

	private peekNextBufferedChunk(): string {
		const newlineIndex = this.lineBuffer.indexOf("\n");
		if (newlineIndex >= 0) return this.lineBuffer.slice(0, newlineIndex + 1);
		return this.lineBuffer;
	}

	private finishInLeakLine(endsWithNewline: boolean): void {
		if (!endsWithNewline) return;
		if (this.pendingLooseBlock) {
			this.pendingLooseBlock = false;
			const next = this.peekNextBufferedChunk();
			if (looksLikeLooseBlockContinuation(next)) {
				this.mode = "IN_LOOSE_BLOCK";
				this.looseBlockLinesRemaining = LOOSE_BLOCK_MAX_LINES;
			} else {
				this.mode = "NORMAL";
			}
			return;
		}
		this.mode = "NORMAL";
	}

	private processChunk(chunk: string, endsWithNewline: boolean, atLineStart: boolean): string[] {
		const trimmed = chunk.trim();

		switch (this.mode) {
			case "IN_LEAK_LINE":
				this.suppress(chunk);
				this.finishInLeakLine(endsWithNewline);
				return [];

			case "IN_LOOSE_BLOCK":
				if (!atLineStart) {
					this.suppress(chunk);
					return [];
				}
				if (looksLikeNormalProse(trimmed)) {
					this.mode = "NORMAL";
					return [chunk];
				}
				this.suppress(chunk);
				if (trimmed) {
					this.looseBlockLinesRemaining--;
					if (this.looseBlockLinesRemaining <= 0) this.mode = "NORMAL";
				}
				return [];

			case "NORMAL":
				if (!atLineStart) return [chunk];

				if (isIncompleteLooseRanToolLine(chunk)) {
					this.leakDetected = true;
					this.suppress(chunk);
					if (endsWithNewline) {
						this.mode = "IN_LOOSE_BLOCK";
						this.looseBlockLinesRemaining = LOOSE_BLOCK_MAX_LINES - 1;
					} else {
						this.mode = "IN_LEAK_LINE";
						this.pendingLooseBlock = true;
					}
					return [];
				}

				if (isCursorTranscriptLeakLine(chunk)) {
					this.leakDetected = true;
					this.suppress(chunk);
					if (!endsWithNewline) this.mode = "IN_LEAK_LINE";
					return [];
				}

				if (this.leakDetected && isLeakContinuationLine(trimmed)) {
					this.suppress(chunk);
					return [];
				}

				return [chunk];
		}
	}

	private recordSuppressedLine(line: string): void {
		this.suppressedLineCount += 1;
		this.suppressedText += line;
	}
}
