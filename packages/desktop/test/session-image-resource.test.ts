import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireSessionImageResource } from "../src/renderer/src/components/session-image-resource.ts";

describe("session image resource sharing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shares one read, decode, and Blob URL until the last consumer releases it", async () => {
    const readImageResource = vi.fn().mockResolvedValue({
      resourceId: "resource-1",
      mimeType: "image/png",
      data: "aW1hZ2U=",
    });
    vi.stubGlobal("window", { desktop: { sessions: { readImageResource } } });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-image");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const first = acquireSessionImageResource("attachment-1", "resource-1");
    const second = acquireSessionImageResource("attachment-1", "resource-1");

    await expect(first.promise).resolves.toBe("blob:shared-image");
    await expect(second.promise).resolves.toBe("blob:shared-image");
    expect(readImageResource).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    first.release();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    second.release();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });
});
