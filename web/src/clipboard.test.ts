import { afterEach, describe, expect, it, vi } from "vitest";

import { writeClipboardTextFromPromise } from "./clipboard";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("writeClipboardTextFromPromise", () => {
  it("starts a ClipboardItem write before asynchronous text resolves", async () => {
    let itemData: Record<string, Promise<Blob> | Blob> | undefined;
    class TestClipboardItem {
      constructor(data: Record<string, Promise<Blob> | Blob>) {
        itemData = data;
      }
    }
    const write = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    const text = deferred<string>();

    const result = writeClipboardTextFromPromise(text.promise);

    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    text.resolve("project-scoped loop prompt");
    await result;
    const blob = await itemData?.["text/plain"];
    expect(blob?.size).toBe("project-scoped loop prompt".length);
    expect(blob?.type).toBe("text/plain");
  });

  it("falls back to writeText when ClipboardItem writes are unavailable", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await writeClipboardTextFromPromise(Promise.resolve("fallback prompt"));

    expect(writeText).toHaveBeenCalledWith("fallback prompt");
  });

  it("returns a rejected promise when ClipboardItem construction throws synchronously", async () => {
    class ThrowingClipboardItem {
      constructor() {
        throw new DOMException("Clipboard permission denied", "NotAllowedError");
      }
    }
    const write = vi.fn(async () => undefined);
    vi.stubGlobal("ClipboardItem", ThrowingClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write } });

    let result: Promise<void> | undefined;
    expect(() => {
      result = writeClipboardTextFromPromise(Promise.resolve("prompt"));
    }).not.toThrow();
    await expect(result).rejects.toMatchObject({ name: "NotAllowedError" });
  });
});
