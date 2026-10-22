/**
 * Shared by both hooks: where a turn's words are kept, and what counts as unchanged.
 *
 * The behavioural contract asks a model to send exactly what its person typed.
 * Asking is all a tool description can do, and on every host without hooks it is
 * all there is. Here it can be checked, which is the entire reason this plugin
 * exists rather than a bare `claude mcp add` line in a README.
 *
 * WHY THIS IS NOT A SUBSTRING TEST, WHICH IS WHAT IT WAS FIRST.
 *
 * "Is the sent text somewhere in what they typed" sounds like the same rule and
 * is not remotely the same rule. It permits any contiguous excerpt of anything
 * on screen, and a review found fifteen ways through it in one sitting. "tell
 * them no, I don't want to meet" sends "want to meet". "tell them I can't make
 * it tonight" sends "I can". A prompt quoting somebody else's message lets that
 * person's words go out as yours. "I don't know what to say" contains "no". And
 * because no call knows about any other, a model sending one word at a time
 * composes whole sentences out of your vocabulary, every fragment passing
 * honestly.
 *
 * So the rule is equality, not containment: what goes out has to BE the message,
 * not appear inside it. The two allowances are the ones people actually need.
 */

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A capture older than this cannot describe the turn being sent. */
export const CAPTURE_TTL_MS = 15 * 60_000;

/**
 * A per-session file under the OS temp directory, named by a hash of the id.
 *
 * Hashed because a session id goes into a filename and nothing should be able to
 * steer that into a path. Returns null without one rather than falling back to a
 * shared name: every session missing an id would otherwise read and write the
 * same file, so one session's prompt could authorise another's send.
 */
export function captureFile(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const safe = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return path.join(tmpdir(), `fyreflock-turn-${safe}.json`);
}

/**
 * Fold only what is not a difference a person would recognise.
 *
 * Spacing, because a model reflowing a line it did not otherwise touch has not
 * changed it, and quote and dash shape, because a terminal, a keyboard and a
 * model disagree about which apostrophe is which.
 *
 * Case is NOT folded. Sending "I'M ANNOYED" for "i'm annoyed" is shouting at
 * somebody in your name, which is exactly the kind of change this exists to
 * refuse.
 */
export function normalize(s) {
  return String(s ?? '')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The ways people actually address an assistant, and nothing more.
 *
 * Nobody types a bare line at Claude; they say "tell them X". Refusing that
 * would make the plugin unusable, so the lead-in is stripped and what follows
 * has to be the whole of the rest. It is anchored at the start and allows only
 * one clause, so "don't tell them: I'm broke" does not become a licence to send
 * "I'm broke", and a second line of the prompt can never be sent on its own.
 */
/**
 * At most ONE addressee word, and never a word that is also a message word.
 *
 * The pronoun group used to be a `*`, so it kept eating: "tell them they cannot
 * come" also authorised "cannot come", and "say that this is a terrible idea"
 * authorised "is a terrible idea". Those are not the message the person wrote,
 * they are the message with its subject removed, which is a different sentence
 * passing as verbatim.
 *
 * `that`, `this` and `they` are gone from the list entirely for the same reason:
 * each is a subject at least as often as it is an addressee, and there is no way
 * to tell which from a regular expression. Somebody who writes "tell them that
 * is wrong" simply gets asked to send it as they wrote it.
 */
const LEAD_IN =
  /^(?:ok(?:ay)?[,\s]+)?(?:please[,\s]+)?(?:can you[,\s]+)?(?:just[,\s]+)?(?:tell|say|send|reply|respond|write|answer|message)\b(?:\s+(?:to\s+)?(?:them|him|her|it|back))?(?:\s+exactly)?(?:\s+this)?\s*[:,\-–—]?\s*(?:that\s+)?/i;

/** A pair of matching quotes around the whole thing is packaging, not content. */
function unwrap(s) {
  const m = /^(["'])([\s\S]*)\1$/.exec(s);
  return m ? m[2].trim() : s;
}

/**
 * A backtick span the person offered AS the message, not merely one they typed.
 *
 * The first version collected every span in the prompt and accepted any of them.
 * On Claude Code, which is the only host this targets, people backtick paths,
 * commands and pasted values constantly, so that turned every one of those into
 * something the model could send to a stranger and have certified as verbatim:
 *
 *   "my `~/.ssh/config` is broken, ask them if they have hit this"  -> sends the path
 *   "why does `AKIAQQQ` show up in my logs? anyway say hi"          -> sends the key
 *   "tell them `I can make it`, no wait, `I cannot make it`"        -> sends the wrong one
 *
 * So the span has to BE the message: the whole prompt is one span, or the whole
 * remainder after a lead-in is one span. That keeps the escape hatch for its
 * actual purpose, which is sending something the rules below would mangle, and
 * removes it as a way to lift arbitrary text out of somebody's screen.
 */
export function offeredSpan(prompt) {
  const text = String(prompt ?? '');
  const spans = text.match(/`[^`\n]+`/g) ?? [];
  /**
   * Exactly one span, and it ends the prompt.
   *
   * Two spans means the person was weighing options or quoting several things,
   * and nothing here can say which one they meant. Trailing prose after the
   * span means the span was a subject rather than an offer: "my `~/.ssh/config`
   * is broken, ask them about it" mentions a path, it does not hand one over.
   * What survives is the shape people actually use to dictate: the span last,
   * alone, with at most an introduction in front of it.
   */
  if (spans.length !== 1) return null;
  if (!text.trimEnd().endsWith(spans[0])) return null;
  return spans[0].slice(1, -1);
}

/**
 * Is this text the person's message for this turn?
 *
 * Three ways to be yes, in order of how precisely the person asked for it:
 * something they wrapped in backticks, byte for byte, which is the escape hatch
 * for anything the rules below would mangle; their whole prompt; or their prompt
 * with one leading "tell them" removed. Anything else is a no, including an
 * excerpt of any of them.
 */
export function isVerbatim(sentText, typedPrompt) {
  const raw = String(sentText ?? '');
  // Whitespace with nothing in it is not a message, and normalising made it
  // indistinguishable from an empty send, which used to be allowed outright.
  if (raw.trim().length === 0) return false;

  // Byte for byte, deliberately before normalisation: the point of backticks is
  // that what is inside them is not touched by anything.
  if (offeredSpan(typedPrompt) === raw) return true;

  const sent = unwrap(normalize(raw));
  const typed = normalize(typedPrompt);
  if (typed.length === 0 || sent.length === 0) return false;

  if (unwrap(typed) === sent) return true;
  const withoutLeadIn = typed.replace(LEAD_IN, '');
  return withoutLeadIn !== typed && unwrap(withoutLeadIn.trim()) === sent;
}
