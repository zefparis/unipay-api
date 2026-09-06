export function isSandboxAllowed(nodeEnv: string, requestedMode: unknown): boolean {
  return nodeEnv !== 'production' && requestedMode === 'sandbox';
}
