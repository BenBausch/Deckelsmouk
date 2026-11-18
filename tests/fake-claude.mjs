#!/usr/bin/env node
// Stand-in for the Claude Code CLI in tests: logs how it was called, marks the current slide in deck.html, and
// speaks the same stream-json the real CLI does. A prompt containing SLOW waits long enough to be stopped.
import fs from 'node:fs';
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt: input }) + '\n');
  const out = o => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  if (input.includes('SLOW')) await new Promise(r => setTimeout(r, 30000));
  const deck = /decks\/([^/]+)\//.exec(input)[1];
  const id = /id="([^"]+)"/.exec(input)[1];
  const file = `decks/${deck}/deck.html`;
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${process.cwd()}/${file}` } }] } });
  const html = fs.readFileSync(file, 'utf8').replace(new RegExp(`(<section[^>]*id="${id}")`), '$1 data-claude="touched"');
  fs.writeFileSync(file, html);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Marked the slide.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.001, duration_ms: 5, session_id: 'sess-1' });
});
