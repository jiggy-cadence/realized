/**
 * mcp-client.js — thin wrapper around the Subgraph MCP remote SSE endpoint.
 *
 * The Graph's Subgraph MCP server does not hold a model; it translates MCP tool
 * calls into GraphQL against Subgraph deployments and returns structured results.
 * We speak to it over the documented `mcp-remote` bridge pattern:
 *   https://subgraphs.mcp.thegraph.com/sse  +  Authorization: Bearer <Gateway API key>
 *
 * Needs GRAPH_GATEWAY_API_KEY in the environment (from thegraph.com/studio — wallet
 * connect required, so this key is Jiggy's to create, not ours to fabricate).
 *
 * Until that key exists, every call here throws NO_LIVE_KEY rather than silently
 * falling back to fixture data — a monitor that quietly serves fake numbers under
 * a "live" label is worse than one that refuses to run.
 */

const { spawn } = require('child_process');

const MCP_URL = 'https://subgraphs.mcp.thegraph.com/sse';

class NoLiveKeyError extends Error {
  constructor() {
    super('GRAPH_GATEWAY_API_KEY not set — cannot reach the live Subgraph MCP endpoint. ' +
          'Get one at thegraph.com/studio (Create API Key), then set the env var. ' +
          'This is intentional: we do not fall back to fixtures under the live code path.');
    this.name = 'NoLiveKeyError';
  }
}

/**
 * Calls an MCP tool on the remote Subgraph MCP server via the mcp-remote bridge.
 * @param {string} tool - MCP tool name, e.g. 'search_subgraphs' or 'execute_query'
 * @param {object} args - tool arguments
 * @returns {Promise<object>} parsed tool result
 */
function callTool(tool, args) {
  const key = process.env.GRAPH_GATEWAY_API_KEY;
  if (!key) return Promise.reject(new NoLiveKeyError());

  return new Promise((resolve, reject) => {
    // mcp-remote speaks MCP-over-stdio locally and bridges to the SSE endpoint.
    // We invoke it as a short-lived subprocess per call — simplest correct thing
    // for a hackathon judge to read and re-run; a persistent client is a stretch goal.
    const proc = spawn('npx', [
      '-y', 'mcp-remote',
      '--header', `Authorization:Bearer ${key}`,
      MCP_URL
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const req = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: tool, arguments: args }
    }) + '\n';

    let out = '';
    let err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      if (code !== 0 && !out) return reject(new Error(`mcp-remote exited ${code}: ${err.slice(0, 300)}`));
      try {
        const lines = out.trim().split('\n').filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1]);
        if (last.error) return reject(new Error(`MCP error: ${JSON.stringify(last.error)}`));
        resolve(last.result);
      } catch (e) {
        reject(new Error(`Failed to parse MCP response: ${e.message}. Raw: ${out.slice(0, 300)}`));
      }
    });
    proc.stdin.write(req);
    proc.stdin.end();
  });
}

module.exports = { callTool, NoLiveKeyError, MCP_URL };
