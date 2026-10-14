/** Saves bytes or text as a file through a temporary object URL. */
export function saveFile(name: string, content: Uint8Array | string, type: string): void {
  const blob = new Blob([typeof content === "string" ? content : new Uint8Array(content)], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
