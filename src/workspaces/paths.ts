// ── Workspace Data Root Resolution ─────────────────────────────────
// Resolves the Firestore path prefix based on workspace context.
// When workspaceId is present, data lives under workspaces/{id}.
// When null/undefined, data lives under users/{uid} (personal).

export function resolveDataRoot(
  workspaceId: string | null | undefined,
  uid: string,
): string {
  if (workspaceId) {
    return `workspaces/${workspaceId}`;
  }
  return `users/${uid}`;
}
