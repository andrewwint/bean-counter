/**
 * Config env-var access. Reads a var by its `BATON_<suffix>` name — a thin accessor so the
 * config-var prefix lives in one place. `envAlias("MODEL")` reads `process.env.BATON_MODEL`.
 */
export function envAlias(suffix: string): string | undefined {
  return process.env["BATON_" + suffix];
}
