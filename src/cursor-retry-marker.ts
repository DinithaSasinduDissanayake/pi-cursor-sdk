import type { Message } from "@earendil-works/pi-ai/compat";
import { resolveCursorRetryMarkerEnabled } from "./cursor-leak-fix-env.js";

export const CURSOR_RETRY_AFTER_ABORT_MARKER =
	"[note: the previous attempt at this request was interrupted before completing; the user has sent the same request again. Respond fresh — do not continue or replay any earlier partial output.]";

function getUserMessageText(msg: Message): string {
	if (msg.role !== "user") return "";
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

function assistantSerializesToNothing(msg: Message): boolean {
	if (msg.role !== "assistant") return false;
	const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: String(msg.content) }];
	for (const block of blocks) {
		if (block.type === "text" && block.text) return false;
		if (block.type === "toolCall") return false;
	}
	return true;
}

export function isFailedAssistantTurn(msg: Message): boolean {
	if (msg.role !== "assistant") return false;
	const assistant = msg as Message & { stopReason?: string; errorMessage?: string };
	if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return true;
	if (typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()) return true;
	return assistantSerializesToNothing(msg);
}

export function findLatestUserMessageIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "user") return index;
	}
	return -1;
}

function findPreviousUserMessageText(messages: readonly Message[], latestUserIndex: number): string | undefined {
	for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
		if (messages[index].role !== "user") continue;
		const text = getUserMessageText(messages[index]).trim();
		if (text) return text;
	}
	return undefined;
}

function findMostRecentAssistantBefore(messages: readonly Message[], beforeIndex: number): Message | undefined {
	for (let index = beforeIndex - 1; index >= 0; index -= 1) {
		if (messages[index].role === "assistant") return messages[index];
	}
	return undefined;
}

export function shouldApplyRetryAfterAbortMarker(
	messages: readonly Message[],
	options: { enabled?: boolean } = {},
): boolean {
	if (options.enabled === false || !resolveCursorRetryMarkerEnabled()) return false;
	const latestUserIndex = findLatestUserMessageIndex(messages);
	if (latestUserIndex <= 0) return false;
	const latestText = getUserMessageText(messages[latestUserIndex]).trim();
	const previousText = findPreviousUserMessageText(messages, latestUserIndex);
	if (!latestText || !previousText || latestText !== previousText) return false;
	const priorAssistant = findMostRecentAssistantBefore(messages, latestUserIndex);
	return priorAssistant !== undefined && isFailedAssistantTurn(priorAssistant);
}

export function applyRetryAfterAbortMarkerToUserText(
	text: string,
	messages: readonly Message[],
	options: { enabled?: boolean } = {},
): string {
	if (!shouldApplyRetryAfterAbortMarker(messages, options)) return text;
	return `${CURSOR_RETRY_AFTER_ABORT_MARKER}\n${text}`;
}
