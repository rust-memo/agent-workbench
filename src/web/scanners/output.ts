/** Strip terminal control sequences before they reach logs or browser JSON. */
export function clean(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC is untrusted terminal control data we intentionally remove.
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI is untrusted terminal control data we intentionally remove.
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: C0 controls are intentionally stripped from scanner output.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, '')
  );
}
