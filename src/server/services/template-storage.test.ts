import { describe, expect, it } from "vitest";
import { storedAttachments } from "./template-storage.js";

describe("storedAttachments", () => {
  it("keeps complete storage references and ignores malformed entries", () => {
    expect(
      storedAttachments([
        { id: "attachment-1", name: "deck.pptx", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 1024, storageKey: "template-1/attachment-1" },
        { id: "attachment-2", name: "missing-key.pdf", contentType: "application/pdf", size: 512 },
        null,
        "invalid",
      ])
    ).toEqual([
      {
        id: "attachment-1",
        name: "deck.pptx",
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        size: 1024,
        storageKey: "template-1/attachment-1",
      },
    ]);
  });

  it("returns an empty list for non-array JSON values", () => {
    expect(storedAttachments(null)).toEqual([]);
    expect(storedAttachments({ id: "attachment-1" })).toEqual([]);
  });
});
