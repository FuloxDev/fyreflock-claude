/**
 * PreToolUse on the send tools: refuse a line the person did not write.
 *
 * This is the one place in the whole product where "your assistant sends your
 * words unchanged" is enforced rather than requested. Everywhere else it is a
 * sentence in a tool description, which a model is free to read and then
 * paraphrase anyway, and the person on the other end has no way to tell.
 */
import { readFileSync } from 'node:fs';
import { captureFile, matchesDigests } from './verbatim.mjs';

/**
 * Exit 2, and the reason on stderr.
 *
 * The docs are explicit that a hook meant to enforce a policy should use exit 2,
 * which blocks whether or not anything reached stdout. The JSON form is written
 * as well because it renders better, but it must not be the only thing standing
 * between a stranger and a message the person did not write: an unflushed pipe
 * on a larger payload would turn a refusal into exit 0, which means allow.
 */
function deny(reason) {
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }),
    );
  } catch {
    /* stderr and the exit code are the load-bearing half. */
  }
  process.stderr.write(reason);
  process.exit(2);
}

/** No output and exit 0 leaves the call to the ordinary permission flow. */
const allow = () => process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    // Malformed input is this plugin failing, not the model misbehaving.
    return allow();
  }

  /**
   * An explicit opt-out, not any truthy value.
   *
   * `if (process.env.X)` treats "0" and "false" as on, so somebody switching
   * this off would switch it off, and somebody switching it off by setting it to
   * "0" would also switch it off. Only the two spellings that mean yes count.
   *
   * There is no assist or translate mode on the server today. When there is, the
   * peer is meant to be told and shown the original; until then this is a local
   * escape hatch for somebody who wants help writing a line, and nothing more.
   */
  const assist = String(process.env.FYREFLOCK_ASSIST ?? '').toLowerCase();
  if (assist === '1' || assist === 'true') return allow();

  /**
   * The field is not always called `text`, and reading only `text` fails OPEN.
   *
   * `fyreflock_game_move` carries the person's words in `move`, up to 400
   * characters shown verbatim to the other player: a third send channel that the
   * matcher did not cover and that this function would have waved through even
   * once it did, silently, because a missing `text` is treated as "nothing to
   * check". Two independent misses producing one unenforced channel.
   *
   * Listed explicitly rather than scanning every string in `tool_input`, so that
   * a future tool with an incidental string field is not accidentally policed as
   * if it were a message.
   */
  const args = input?.tool_input ?? {};
  const text = typeof args.text === 'string' ? args.text : typeof args.move === 'string' ? args.move : null;
  // Nothing to compare. Let the server's own schema reject it.
  if (text === null || text.length === 0) return allow();

  const file = captureFile(input.session_id);
  // No session id means nothing can be correlated to this turn, and guessing
  // would mean reading somebody else's capture.
  if (!file) return allow();

  let saved = null;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    /**
     * Fails OPEN only when there is no capture at all, and that is a deliberate
     * trade. A missing file means the companion hook never ran: a fresh install,
     * a cleared temp directory, a session that began before the plugin did.
     * Denying there would block somebody's first real message for a condition
     * that is our fault rather than the model's. Anything else unreadable is
     * treated as the person having typed nothing.
     */
    if (err?.code === 'ENOENT') return allow();
  }

  /**
   * The turn, not the clock. This used to trust a capture for fifteen minutes
   * and allow anything after that, so a turn held open by two long waits failed
   * open, and a fresh capture from an earlier turn kept authorising a model
   * acting on its own. Claude Code stamps every event of one prompt with the
   * same `prompt_id`; a capture with another id is from a turn this send is not
   * part of, so the person typed nothing it can be compared with. A Claude Code
   * too old to send the id gets the session's latest prompt, which still lets
   * out only the person's own words.
   */
  const sameTurn = typeof input.prompt_id !== 'string' || saved?.prompt_id === input.prompt_id;
  const accept = sameTurn && Array.isArray(saved?.accept) ? saved.accept : [];

  if (matchesDigests(text, accept)) return allow();

  deny(
    'Fyreflock sends the person\'s own words, and this is not what they typed this turn, so nothing was sent. ' +
      'Call the tool again with their message exactly as they wrote it: copied, not rephrased, corrected, shortened or quoted from somewhere else in the conversation. ' +
      'If you are unsure which part of what they said is the message, ask them. ' +
      'If they wanted you to compose something, tell them Fyreflock only sends their own words, and ask for the words they want sent. ' +
      'They can also wrap the exact text in backticks to send it byte for byte.',
  );
});
