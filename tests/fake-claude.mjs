#!/usr/bin/env node
// Stand-in for the Claude Code CLI in tests: logs how it was called, marks the current slide in deck.html, and
// speaks the same stream-json the real CLI does. A prompt containing SLOW waits long enough to be stopped.
import fs from 'node:fs';
const args = process.argv.slice(2);

// Version and sign-in commands, with the signed-in state kept in a file.
const STATE = process.env.FAKE_CLAUDE_STATE;
const state = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { loggedIn: true }; } };
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args }) + '\n');
  if (args[1] === 'status') {
    const st = state();
    console.log(JSON.stringify(st.loggedIn ? { loggedIn: true, authMethod: 'claude.ai', email: 'fake@example.com', subscriptionType: 'pro' } : { loggedIn: false }));
    process.exit(0);
  }
  if (args[1] === 'logout') { fs.writeFileSync(STATE, JSON.stringify({ loggedIn: false })); process.exit(0); }
  if (args[1] === 'login') {
    console.log('Opening browser to sign in… If it does not open, visit: https://claude.ai/oauth/authorize?fake=1');
    setTimeout(() => { fs.writeFileSync(STATE, JSON.stringify({ loggedIn: true })); process.exit(0); }, 1500);
  }
} else {
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
}
