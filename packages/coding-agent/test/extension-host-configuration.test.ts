import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionConfiguration } from "../src/core/extensions/types.ts";

describe("extension host configuration", () => {
	it("provides an immutable configuration scoped to the extension factory", async () => {
		const source: ExtensionConfiguration = { endpoint: "https://example.test", retries: 3, enabled: true };
		let received: Readonly<{ endpoint: string; retries: number; enabled: boolean }> | undefined;

		await loadExtensionFromFactory(
			(pi) => {
				received = pi.getConfig<{ endpoint: string; retries: number; enabled: boolean }>();
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:configured>",
			source,
		);

		expect(received).toEqual(source);
		expect(Object.isFrozen(received)).toBe(true);
		expect(() => {
			(received as { endpoint: string }).endpoint = "https://changed.test";
		}).toThrow();
		expect(source.endpoint).toBe("https://example.test");
	});

	it("returns an empty object when the host supplies no configuration", async () => {
		let received: Readonly<Record<string, string | number | boolean>> | undefined;

		await loadExtensionFromFactory(
			(pi) => {
				received = pi.getConfig();
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);

		expect(received).toEqual({});
		expect(Object.isFrozen(received)).toBe(true);
	});
});
