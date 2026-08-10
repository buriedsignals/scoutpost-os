export function dominantValue(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || ranked[0][1] <= values.length / 2) return null;
  return ranked[0][0];
}

export interface ShadowReleaseGates {
  probeFailures: number;
  scoreRegressions: number;
  contractMismatches: number;
  canonicalPassed: boolean;
  latencyPassed: boolean;
  memoryPassed: boolean;
}

export function shadowReleasePassed(gates: ShadowReleaseGates): boolean {
  return gates.probeFailures === 0 && gates.scoreRegressions === 0 &&
    gates.contractMismatches === 0 && gates.canonicalPassed &&
    gates.latencyPassed && gates.memoryPassed;
}
