import type { CursorSdkEventDebugRecorder } from "./cursor-sdk-event-debug.js";
import { resolveCursorLeakGuardEnabled } from "./cursor-leak-fix-env.js";

export const CURSOR_TRANSCRIPT_LEAK_SUPPRESSION_NOTICE_PREFIX =
	"[pi-cursor-sdk: suppressed ";

export const CURSOR_TRANSCRIPT_LEAK_LINE_PATTERNS: readonly RegExp[] = [
	/^\s*\[ran tool .+ (historical record|result pruned)/,
	/^\s*Tool (result|error) \([^)]*call cursor-replay-/,
	/^\s*Assistant: \[ran tool/,
];

const LINE_BUFFER_CAP_CHARS = 500;
const INCOMPLETE_LEAK_PREFIXES = ["[ran tool ", "Tool result (", "Tool error (", "Assistant: [ran tool"] as const;

export function isCursorTranscriptLeakLine(line: string): boolean {
	return CURSOR_TRANSCRIPT_LEAK_LINE_PATTERNS.some((pattern) => pattern.test(line));
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

export class CursorTranscriptLeakGuard {
	private lineBuffer = "";
	private atLineStart = true;
	private leakDetected = false;
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
		if (atLineStart) {
			if (!this.leakDetected && isCursorTranscriptLeakLine(line)) {
				this.leakDetected = true;
				this.recordSuppressedLine(line);
				return [];
			}
			if (this.leakDetected && isCursorTranscriptLeakLine(line)) {
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
