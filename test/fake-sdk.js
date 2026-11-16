/**
 * A stand-in for `@deepseek-ai/dsh-tools#defineTool` with the same observable contract:
 * it validates the tool shape and returns a registry-ready definition. Tests use it so the
 * plugin can be exercised without a running Host.
 */
export function defineTool(options) {
  if (typeof options.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(options.name)) {
    throw new Error(`defineTool: invalid name ${options.name}`)
  }
  if (typeof options.description !== 'string' || options.description.length === 0) {
    throw new Error(`defineTool(${options.name}): description is required`)
  }
  if (typeof options.parameters !== 'object' || options.parameters === null) {
    throw new Error(`defineTool(${options.name}): parameters must be an object`)
  }
  for (const [key, spec] of Object.entries(options.parameters)) {
    if (typeof spec?.type !== 'string') throw new Error(`defineTool(${options.name}): parameter ${key} needs a type`)
  }
  if (!options.output || typeof options.output.render !== 'function') {
    throw new Error(`defineTool(${options.name}): output.render is required`)
  }
  if (typeof options.execute !== 'function') throw new Error(`defineTool(${options.name}): execute is required`)
  return { ...options }
}