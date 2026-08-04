'use strict';

const fs = require('fs');

/**
 * Synthetic user records the harness injects that are not something the user
 * typed. An interrupt is written as a user-role text block, so without this it
 * looks exactly like a prompt and becomes a turn boundary -- orphaning every
 * token spent before the interrupt. Measured at 4.5% of billable tokens across
 * a real transcript corpus.
 */
const SYNTHETIC_USER_TEXT = [
  /^\[request interrupted by user[^\]]*\]$/i,
  /^\[image:[^\]]*\]$/i,
];

function isSyntheticUserText(text) {
  const t = String(text).trim();
  return SYNTHETIC_USER_TEXT.some((re) => re.test(t));
}

/**
 * A "real" user prompt, as opposed to a tool result or an injected meta message.
 * Prompts arrive either as plain string content or as a content array whose first
 * block is text; tool results are content arrays of type "tool_result".
 */
function isUserPrompt(entry) {
  if (!entry || entry.type !== 'user' || !entry.message) return false;
  if (entry.isMeta) return false;
  if (entry.isSidechain) return false;

  const content = entry.message.content;
  if (typeof content === 'string') {
    return content.trim().length > 0 && !isSyntheticUserText(content);
  }
  if (Array.isArray(content)) {
    // Any tool_result block means this is plumbing, not a prompt.
    if (content.some((b) => b && b.type === 'tool_result')) return false;
    const texts = content.filter((b) => b && b.type === 'text'
      && String(b.text).trim().length > 0);
    if (texts.length === 0) return false;
    // A lone synthetic block (an interrupt notice) is not a prompt; a real prompt
    // that merely accompanies an image still is.
    if (texts.length === 1 && isSyntheticUserText(texts[0].text)) return false;
    return true;
  }
  return false;
}

/** Billable tokens for one assistant message, excluding cache reads. */
function messageTokens(usage) {
  if (!usage) return 0;
  return (Number(usage.input_tokens) || 0)
    + (Number(usage.cache_creation_input_tokens) || 0)
    + (Number(usage.output_tokens) || 0);
}

/**
 * Sums tokens spent on the most recent turn: every main-chain assistant message
 * after the last real user prompt.
 *
 * Streaming writes one record per content block, all carrying the same cumulative
 * usage for that message, so records are deduped by message.id. Sidechain
 * (subagent) messages are excluded because they are billed under their own ids
 * and would otherwise be attributed to whichever turn happened to be open.
 *
 * @returns {{tokens:number, messages:number}}
 */
function lastTurnTokens(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch (_) {
    return { tokens: 0, messages: 0 };
  }

  const entries = [];
  for (const line of lines) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch (_) { /* skip partial line */ }
  }

  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isUserPrompt(entries[i])) { start = i; break; }
  }
  // No prompt anywhere means we cannot identify a turn, so there is nothing to
  // attribute. Summing the whole file instead would bill an entire session's
  // tokens as one turn -- and would do it again on every subsequent Stop.
  if (start === -1) return { tokens: 0, messages: 0 };

  const seen = new Set();
  let tokens = 0;
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.type !== 'assistant' || !e.message || e.isSidechain) continue;
    const id = e.message.id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    tokens += messageTokens(e.message.usage);
  }

  return { tokens, messages: seen.size };
}

module.exports = { lastTurnTokens, isUserPrompt, messageTokens, isSyntheticUserText };
