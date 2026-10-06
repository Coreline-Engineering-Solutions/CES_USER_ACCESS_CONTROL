/**
 * Which project panels (Stock Manager, Modules, GIS Projects) the Client
 * Portal shows: exactly the ones whose tool the signed-in person is linked to,
 * the same rule the CES_WEB dashboard uses for its tiles. A System Manager is
 * not an exception - a tool you are not linked to is not shown, however many
 * privileges you hold.
 *
 * Names are compared normalised (underscores, spacing and case ignored), so
 * 'Manager Portal' matches 'manager_portal'.
 */
export function utilityKey(v: unknown): string {
  return String(v ?? '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

type AccessEntry = string | { utility_name?: unknown; name?: unknown } | null | undefined;

export function visibleProjects<T extends { utility: string }>(
  registry: readonly T[],
  accessList: readonly AccessEntry[] | null | undefined,
): T[] {
  const linked = new Set(
    (accessList ?? [])
      .map((e) => utilityKey(typeof e === 'string' ? e : (e?.utility_name ?? e?.name)))
      .filter(Boolean),
  );
  return registry.filter((p) => linked.has(utilityKey(p.utility)));
}
