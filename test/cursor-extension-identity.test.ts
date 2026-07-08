import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatCursorExtensionIdentityLine,
	logCursorExtensionIdentity,
} from "../src/cursor-extension-identity.js";

describe("cursor extension identity", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PI_CURSOR_SDK_EVENT_DEBUG;
	});

	it("formats package version with git sha when available", () => {
		const line = formatCursorExtensionIdentityLine({ version: "0.1.56", gitSha: "abc1234" });
		expect(line).toBe("pi-cursor-sdk 0.1.56 @ abc1234");
	});

	it("formats package version without git sha when unavailable", () => {
		const line = formatCursorExtensionIdentityLine({ version: "0.1.56" });
		expect(line).toBe("pi-cursor-sdk 0.1.56");
	});

	it("logs identity at info level", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		logCursorExtensionIdentity({ PI_CURSOR_SDK_EVENT_DEBUG: undefined });
		expect(info).toHaveBeenCalledWith(expect.stringMatching(/^pi-cursor-sdk \d+\.\d+\.\d+( @ [0-9a-f]+)?$/));
	});

	it("also logs into debug stderr prefix when event debug is enabled", () => {
		process.env.PI_CURSOR_SDK_EVENT_DEBUG = "1";
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		logCursorExtensionIdentity();
		expect(info).toHaveBeenCalledTimes(2);
		expect(info.mock.calls[1]?.[0]).toContain("[pi-cursor-sdk:sdk-events]");
	});
});
