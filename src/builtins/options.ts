/*
 * The name is the subscription key and the log scope: a blank one could not be
 * subscribed to by name and would log as `[]`. The error names the option, not an env var.
 */
export function resolveName(option: string | undefined, defaultName: string): string {
  if (option === undefined) return defaultName
  if (option.trim() === '') {
    throw new Error(`${defaultName}({ name }) must not be empty, got "${option}"`)
  }
  return option
}
