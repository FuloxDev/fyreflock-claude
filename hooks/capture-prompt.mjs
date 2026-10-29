/**
 * UserPromptSubmit: keep this turn's words so the next hook can check them.
 *
 * Runs on every prompt, does nothing to it, and posts nothing anywhere. It
 * writes one small file on this machine and exits, which is the only reason it
 * is acceptable to have a hook in the path of everything somebody types.
 */
import { writeFileSync } from 'node:fs';
import { acceptedDigests, captureFile } from './verbatim.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const file = captureFile(input.session_id);
    // No id, nothing to key on. Writing to a shared name would let one session's
    // prompt authorise another session's send.
    if (file) {
      /**
       * Digests, never the words, and one file per session that each prompt
       * overwrites. `prompt_id` is what ties it to this turn: Claude Code stamps
       * every event of one prompt with it, so the check can tell a send from
       * this turn from one in a turn the person never typed in, however long
       * either runs. 0600 because the temp directory's default is world readable.
       */
      writeFileSync(
        file,
        JSON.stringify({ prompt_id: typeof input.prompt_id === 'string' ? input.prompt_id : null, accept: acceptedDigests(input.prompt ?? '') }),
        { encoding: 'utf8', mode: 0o600 },
      );
    }
  } catch {
    /**
     * Silence is correct here, and it is the only place in this plugin where it
     * is. This hook sits in front of every prompt in the session: a stray write
     * error must never turn into a broken prompt or a message on somebody's
     * screen. If the capture is missing, the checking hook fails open and says
     * so in its own reasoning.
     */
  }
  // No output, exit 0: the prompt goes through exactly as typed.
  process.exit(0);
});
