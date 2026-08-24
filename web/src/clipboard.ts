export function writeClipboardTextFromPromise(text: Promise<string>): Promise<void> {
  if (
    typeof ClipboardItem !== "undefined"
    && typeof navigator.clipboard?.write === "function"
  ) {
    const textBlob = text.then((content) => new Blob([content], { type: "text/plain" }));
    try {
      return navigator.clipboard.write([
        new ClipboardItem({ "text/plain": textBlob }),
      ]);
    } catch (error) {
      void textBlob.catch(() => undefined);
      return Promise.reject(error);
    }
  }

  return text.then((content) => navigator.clipboard.writeText(content));
}
