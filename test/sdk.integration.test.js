/**
 * Integration test against the real `@deepseek-ai/dsh-tools` when a DSH checkout is available.
 *
 * It proves that every tool this plugin registers compiles through the Host's own `defineTool`
 * - i.e. the parameter and output specs are what the SDK actually accepts, not merely what this
 * repository's fake SDK accepts.
 *
 * Set DSH_TOOLS_PATH to the built module to point at a different checkout; the test skips when
 * the module cannot be imported.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerTools, TOOL_NAMES } from '../src/plugin.js'

const DEFAULT_PATH = 'file:///Y:/DSH/deepseek-harness/packages/core/tools/lib/index.js'
const SDK_PATH = process.env.DSH_TOOLS_PATH ?? DEFAULT_PATH

test('every tool spec compiles through the real dsh-tools defineTool', async t => {
  let sdk
  try {
    sdk = await import(SDK_PATH)
  } catch {
    t.skip(`dsh-tools not importable at ${SDK_PATH}`)
    return
  }
  assert.equal(typeof sdk.defineTool, 'function')

  const registered = new Map()
  const ctx = { tools: { register: definition => { registered.set(definition.name, definition); return () => registered.delete(definition.name) } } }
  const dispose = registerTools(ctx, { defineTool: sdk.defineTool, config: {} })

  assert.equal(registered.size, TOOL_NAMES.length)
  for (const name of TOOL_NAMES) assert.ok(registered.has(name), `${name} must be registered`)

  for (const [name, definition] of registered) {
    assert.equal(definition.name, name)
    // compiled parameter schema: an implicit open object root
    assert.equal(definition.parameters.type, 'object', `${name}: parameters must compile to an object schema`)
    assert.equal(typeof definition.parameters.properties, 'object', `${name}: parameters need properties`)
    assert.ok(definition.parameters.required.includes('runDir') || name === 'pcb_geometry_drc',
      `${name}: runDir should be required unless the tool does not take a run`)
    assert.ok(definition.output.schema, `${name}: output schema must compile`)
  }
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(registered.size, 0)
})