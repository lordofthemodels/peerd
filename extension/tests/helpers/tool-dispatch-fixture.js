// @ts-check
// Test-local composition of the production prepare/execute/settle phases.
// Production tool execution is owned by the sealed controller; tests that need
// a synthetic executor keep their mutable inventory in the pruned test tree.

import {
  executePreparedToolCall,
  prepareToolCall,
  settleToolCall,
} from '../../peerd-runtime/tools/dispatcher.js';
import {
  resolveDescriptorOrigins,
  retryClassForDescriptor,
  toToolDescriptor,
} from '../../peerd-runtime/tools/metadata/descriptor.js';
import { listToolPolicies } from '../../peerd-runtime/tools/metadata/policy.js';

/** @typedef {import('../../shared/tool-types.js').Tool} Tool */
/** @typedef {ReturnType<typeof toToolDescriptor>} ToolDescriptor */

/** @type {Map<string, Tool>} */
const tools = new Map();
/** @type {Map<string, ToolDescriptor>} */
const toolDescriptors = new Map();
/** @type {Map<string, ToolDescriptor>} */
const metadataDescriptors = new Map();

/** @param {Tool} tool */
export const registerTool = (tool) => {
  if (!tool || typeof tool.name !== 'string' || !tool.name) {
    throw new TypeError('registerTool: tool.name is required');
  }
  if (typeof tool.execute !== 'function') {
    throw new TypeError(`registerTool: tool '${tool.name}' has no execute()`);
  }
  if (typeof tool.primitive !== 'string') {
    throw new TypeError(`registerTool: tool '${tool.name}' is missing the primitive field`);
  }
  tools.set(tool.name, tool);
  toolDescriptors.set(tool.name, toToolDescriptor(tool));
};

/** @param {string} name */
export const getTool = (name) => tools.get(name);
export const listTools = () => [...tools.values()];
export const clearTools = () => {
  tools.clear();
  toolDescriptors.clear();
};

export const registerMetadataInventory = (inventory = listToolPolicies()) => {
  if (!Array.isArray(inventory)) throw new TypeError('metadata inventory must be an array');
  const next = new Map();
  for (const metadata of inventory) {
    const descriptor = toToolDescriptor(metadata);
    if (next.has(descriptor.name)) {
      throw new TypeError(`duplicate tool metadata: ${descriptor.name}`);
    }
    next.set(descriptor.name, descriptor);
  }
  metadataDescriptors.clear();
  for (const [name, descriptor] of next) metadataDescriptors.set(name, descriptor);
  return metadataDescriptors.size;
};

/** @param {string} name */
export const getToolDescriptor = (name) =>
  toolDescriptors.get(name) ?? metadataDescriptors.get(name);

export const listToolDescriptors = () => {
  const execution = [...toolDescriptors.values()];
  const byName = new Map(execution.map((descriptor) => [descriptor.name, descriptor]));
  return [
    ...[...metadataDescriptors].map(([name, descriptor]) => byName.get(name) ?? descriptor),
    ...execution.filter((descriptor) => !metadataDescriptors.has(descriptor.name)),
  ];
};

/** @param {string} name @param {any} args @param {any} ctx */
export const resolveRegisteredToolOrigins = (name, args, ctx) => {
  const descriptor = getToolDescriptor(name);
  return descriptor ? resolveDescriptorOrigins(descriptor, args, ctx) : [];
};

/** @param {string} name */
export const retryClassForRegisteredTool = (name) =>
  retryClassForDescriptor(getToolDescriptor(name));

/**
 * @param {import('../../shared/tool-types.js').ToolCall} call
 * @param {any} ctx
 * @param {{execute?:(prepared:Record<string, any>)=>Promise<any>|any}} [options]
 */
export const dispatchToolCall = async (call, ctx, options = {}) => {
  const descriptor = getToolDescriptor(call.name);
  const prepared = /** @type {any} */ (await prepareToolCall(call, ctx, descriptor));
  if (prepared?.prepared !== true) return prepared;
  const execute = options.execute ?? ((request) => {
    const implementation = getTool(request.tool.name);
    if (!implementation || getToolDescriptor(request.tool.name) !== request.tool) {
      return {
        ok: false,
        error: `tool_implementation_unavailable:${request.tool.name}`,
        code: 'tool-implementation-unavailable',
        outcomeKnown: true,
        outcomeKind: /** @type {const} */ ('pre-effect-failure'),
        retryable: true,
      };
    }
    return implementation.execute(request.args, request.execCtx);
  });
  return settleToolCall(prepared, await executePreparedToolCall(prepared, execute));
};
