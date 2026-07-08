/**
 * JSON for embedding inside an inline <script> block. Plain JSON.stringify
 * escapes quotes but leaves `<` and `>` intact, so a value containing
 * `</script>` would close the element early. Only the admin authors these
 * values, so this is defense-in-depth — but it's a one-liner and closes the
 * script-breakout hole.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}
