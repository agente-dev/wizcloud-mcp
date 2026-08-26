/** Public, non-sensitive startup diagnostics for the stdio server. */
export function formatListeningMessage(server: string): string {
  return `wizcloud-mcp: listening on stdio (server=${server})`;
}
