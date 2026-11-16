/**
 * DSH plugin entry: mounts the PCB design harness tools on the Host tool service.
 * @module @yinbo-liao/dsh-pcb
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { registerTools } from './src/plugin.js'

export const name = 'dsh-pcb'
export const inject = ['tools']

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - row config: `{ runDir?, boardDir?, base?, kicadPath? }`.
 * @returns {Function} disposer.
 */
export function apply(ctx, config = {}) {
  return registerTools(ctx, { defineTool, config })
}