import { describe, expect, it } from "vitest";
import { imageAttachmentAdapter, toPiImageInputs } from "../src/renderer/src/runtime/image-attachments.ts";

describe("assistant-ui 图片附件", () => {
  it("将 pending 图片转换为 Pi IPC 输入", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" });
    const attachment = await imageAttachmentAdapter.add({ file });

    await expect(toPiImageInputs([attachment])).resolves.toEqual([
      {
        name: "screen.png",
        mimeType: "image/png",
        data: "AQID",
      },
    ]);
  });

  it("为同名剪贴板图片生成不同的附件 ID", async () => {
    const first = await imageAttachmentAdapter.add({
      file: new File([new Uint8Array([1])], "image.png", { type: "image/png" }),
    });
    const second = await imageAttachmentAdapter.add({
      file: new File([new Uint8Array([2])], "image.png", { type: "image/png" }),
    });

    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe("image.png");
    expect(second.name).toBe("image.png");
  });

  it("保留已完成附件的文件名", async () => {
    await expect(
      toPiImageInputs([
        {
          id: "image-1",
          type: "image",
          name: "fallback.png",
          status: { type: "complete" },
          content: [{ type: "image", image: "data:image/jpeg;base64,/9j/", filename: "photo.jpg" }],
        },
      ]),
    ).resolves.toEqual([
      {
        name: "photo.jpg",
        mimeType: "image/jpeg",
        data: "/9j/",
      },
    ]);
  });

  it("并行完成 pending 图片，并按 Composer 顺序展开结果", async () => {
    const first = await imageAttachmentAdapter.add({
      file: new File([new Uint8Array([1])], "first.png", { type: "image/png" }),
    });
    const second = await imageAttachmentAdapter.add({
      file: new File([new Uint8Array([2])], "second.png", { type: "image/png" }),
    });
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const converting = toPiImageInputs([first, second], async (attachment) => {
      started.push(attachment.id);
      await new Promise<void>((resolve) => releases.set(attachment.id, resolve));
      return {
        id: attachment.id,
        type: "image",
        name: attachment.name,
        contentType: "image/png",
        status: { type: "complete" },
        content: [{ type: "image", image: `data:image/png;base64,${attachment.id}` }],
      };
    });

    expect(started).toEqual([first.id, second.id]);
    releases.get(second.id)?.();
    releases.get(first.id)?.();
    await expect(converting).resolves.toEqual([
      { name: "first.png", mimeType: "image/png", data: first.id },
      { name: "second.png", mimeType: "image/png", data: second.id },
    ]);
  });
});
