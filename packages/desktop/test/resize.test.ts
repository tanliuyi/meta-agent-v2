import { describe, expect, it } from "vitest";
import { limitSize } from "../src/renderer/src/components/ui/use-resize.ts";

describe("limitSize", () => {
	it("限制在最小值和最大值之间", () => {
		expect(limitSize(120, 160, 600)).toBe(160);
		expect(limitSize(420.4, 160, 600)).toBe(420);
		expect(limitSize(900, 160, 600)).toBe(600);
	});

	it("视口过小时仍保留可用的最小值", () => {
		expect(limitSize(200, 360, 240)).toBe(360);
	});
});
