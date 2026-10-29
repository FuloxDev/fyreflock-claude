import { atom, read, update } from 'claude-code';
import type { ElementConstructor, EngineInterface, InputProps, Register } from 'claude-code';

import type { FyreflockLine, FyreflockView } from '../types';

/**
 * The Fyreflock pane: the conversation beside the transcript, with the model out of the path.
 *
 * The mods API reaches the network through `$.http.fetch` only, so there is no
 * socket to hold. Instead the pane long-polls `fyreflock_app_wait` on the same
 * MCP surface the model's own tools use, fifty seconds a call, and redraws from
 * the snapshot the server returns: the lines as the server relayed them, the
 * receipts, the queue depth. Nothing here is composed by a model, so what the
 * person types in the field is what the stranger gets, which is the verbatim
 * rule enforced by construction rather than by the hook pair in this folder.
 *
 * The loop starts only when the person opens the pane or runs `/fyreflock`:
 * a globally installed plugin must not hold a connection to fyreflock.com in
 * every unrelated session (REALTIME-PLAN.md, NEEDS YOU 2).
 *
 * Every function that takes `$` is declared at the top of the file because
 * `claude plugin validate` follows `$` only into those.
 */

const PANE = 'fyreflock';
const DEFAULT_URL = 'https://fyreflock.com/mcp';
/**
 * The engine aborts a $.http.fetch with no complete answer after 30 s (measured
 * 2026-10-20 on 2.1.295: 'aborted: no complete answer within 30000ms'), and a
 * held wait that is cut client-side loses whatever the server handed over at
 * the moment of the cut. So the server is told to answer well inside that.
 */
const WAIT_MS = 25_000;
const IDLE_POLL_MS = 20_000;
/** Between two polls that both returned at once: a server that answers instantly must not be hammered. */
const POLL_GAP_MS = 250;
const ERROR_POLL_MS = 5_000;

const CLIENT_ID = 'pane';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const SIGNED_OUT = 'Sign in to Fyreflock first: run /fyreflock.';

/**
 * The pane's own sign-in, kept in `$.store`, which is this plugin's alone.
 * Never in `$.state`: any plugin in the session reads that.
 */
type Auth = { access: string; refresh: string; expiresAt: number };

const EMPTY: FyreflockView = {
  phase: 'off',
  link: null,
  userCode: null,
  me: null,
  peer: null,
  viaAgent: false,
  lines: [],
  queue: null,
  receipt: null,
  note: null,
  unread: 0,
  reconnecting: false,
  video: null,
};

/**
 * The widget's glow colour per state, in the nearest of the person's own theme
 * colours: gold (ready) and yellow (looking) both land on warning, so looking
 * says so in words beside the dot.
 */
const MOOD = { off: 'inactive', idle: 'warning', searching: 'warning', matched: 'success', reconnecting: 'claude', ended: 'error' } as const;
const moodOf = (v: FyreflockView) => (v.phase === 'matched' && v.reconnecting ? 'reconnecting' : v.phase);

const view = atom({ plugin: 'fyreflock', key: 'view' } as const, EMPTY);
const bandHidden = atom({ plugin: 'fyreflock', key: 'bandHidden' } as const, false);

type Snapshot = {
  state: 'idle' | 'searching' | 'matched';
  mirror: {
    peer: { displayName: string; viaAgent?: boolean } | null;
    queue: { agentWaiting: number; textWaiting: number };
    lines: FyreflockLine[];
    deliveredSeq: number;
    readSeq: number;
    pendingVideo?: { peerName: string; youInvited: boolean; youAccepted: boolean; theyAccepted: boolean } | null;
  };
  ended: string | null;
  notices: string[];
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The site the MCP endpoint belongs to: the OAuth server and the call page live there too. */
async function site($: EngineInterface): Promise<string> {
  return ((await $.env.get('FYREFLOCK_URL')) || DEFAULT_URL).replace(/\/mcp\/?$/, '');
}

/** A form post to the OAuth server. Its errors are RFC words the callers act on, so a refusal is an answer, not a throw. */
async function oauth($: EngineInterface, path: string, form: Record<string, string>) {
  const res = await $.http.fetch(`${await site($)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: Object.entries({ client_id: CLIENT_ID, ...form })
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&'),
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    // A proxy's HTML error page carries no OAuth error, which every caller reads as "try again".
  }
  return { ok: res.ok, status: res.status, body };
}

/** Per site: tokens are only good where they were issued, and a dev FYREFLOCK_URL must not overwrite the real sign-in. */
async function authKey($: EngineInterface): Promise<string> {
  return `auth ${await site($)}`;
}

async function keep($: EngineInterface, t: Record<string, unknown>): Promise<string> {
  const auth: Auth = { access: String(t.access_token), refresh: String(t.refresh_token), expiresAt: (await $.clock.now()) + Number(t.expires_in ?? 3600) * 1000 };
  await $.store.set(await authKey($), auth);
  return auth.access;
}

/**
 * One refresh at a time. The long poll and a send can both find the hour up,
 * and the server reads a rotated refresh token coming back after its thirty
 * second grace as theft, revoking the whole sign-in.
 */
let refreshing: Promise<string> | null = null;

function refresh($: EngineInterface): Promise<string> {
  refreshing ??= (async () => {
    try {
      const auth = (await $.store.get(await authKey($))) as Auth | undefined;
      if (!auth) throw new Error(SIGNED_OUT);
      const r = await oauth($, '/oauth/token', { grant_type: 'refresh_token', refresh_token: auth.refresh });
      if (r.ok && typeof r.body.access_token === 'string') return await keep($, r.body);
      // The month ran out, or the person disconnected the pane in Settings: either way only signing in again helps.
      if (r.body.error === 'invalid_grant') {
        await $.store.delete(await authKey($));
        throw new Error('Fyreflock signed this pane out. Sign in again.');
      }
      throw new Error(String(r.body.error_description ?? `Fyreflock answered ${r.status}.`));
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** FYREFLOCK_TOKEN first, so a token from Settings still overrides; then the pane's own sign-in, renewed a minute early. */
async function bearer($: EngineInterface): Promise<string | null> {
  const override = await $.env.get('FYREFLOCK_TOKEN');
  if (override) return override;
  const auth = (await $.store.get(await authKey($))) as Auth | undefined;
  if (!auth) return null;
  return auth.expiresAt - 60_000 > (await $.clock.now()) ? auth.access : refresh($);
}

async function signedIn($: EngineInterface): Promise<boolean> {
  return Boolean(await $.env.get('FYREFLOCK_TOKEN')) || (await $.store.get(await authKey($))) !== undefined;
}

/**
 * The key the server asks the chat box's own tools for, so a model a stranger
 * talked into calling them is refused. It comes in `fyreflock_open`'s `_meta`,
 * which no host shows a model. Held per token, because a key is bound to the
 * account it was minted for; a server that sends none gets none back.
 */
const BOX_KEY = 'fyreflock/box_key';
let box: { token: string; key?: string } | null = null;

/** One `tools/call` over the stateless surface, answered as JSON or as one SSE frame. */
async function callTool($: EngineInterface, name: string, args: Record<string, unknown>, retry = true): Promise<Record<string, unknown>> {
  const app = name.startsWith('fyreflock_app_');
  if (app && box?.token !== (await bearer($))) await callTool($, 'fyreflock_open', {});
  const token = await bearer($);
  if (!token) throw new Error(SIGNED_OUT);
  const url = (await $.env.get('FYREFLOCK_URL')) || DEFAULT_URL;
  const sent = app && box?.key ? { ...args, box_key: box.key } : args;
  const res = await $.http.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: sent } }),
  });
  // The server's clock can end the hour first. An override token has nothing to refresh with, so its 401 stands.
  if (res.status === 401 && retry && !(await $.env.get('FYREFLOCK_TOKEN'))) {
    await refresh($);
    return callTool($, name, args, false);
  }
  const data = res.text.split('\n').filter((l) => l.startsWith('data:')).pop();
  let frame: {
    result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: { text?: string }[]; _meta?: Record<string, unknown> };
    error?: { message?: string };
    message?: string;
  };
  try {
    frame = JSON.parse(data ? data.slice(5).trim() : res.text);
  } catch {
    throw new Error(`Fyreflock answered ${res.status} with something that is not JSON.`);
  }
  if (!res.ok) throw new Error(frame.message ?? `Fyreflock answered ${res.status}.`);
  if (frame.error) throw new Error(frame.error.message ?? 'Fyreflock refused the call.');
  const s = frame.result?.structuredContent ?? {};
  if (s.ok === false) throw new Error(String(s.message ?? s.error ?? 'refused'));
  if (frame.result?.isError) throw new Error(frame.result.content?.[0]?.text ?? 'tool error');
  if (name === 'fyreflock_open') {
    const key = frame.result?._meta?.[BOX_KEY];
    box = { token, key: typeof key === 'string' ? key : undefined };
  }
  return s;
}

const endedNote = (reason: string, peer: string | null) => {
  const who = peer ? `@${peer}` : 'They';
  if (reason === 'leave' || reason === 'next') return `${who} left the campfire`;
  if (reason === 'disconnect') return `${who} disconnected`;
  if (reason === 'video') return 'Moved to a video call in your browser.';
  return `The conversation ended (${reason}).`;
};

function fromSnapshot(prev: FyreflockView, s: Snapshot): FyreflockView {
  const m = s.mirror;
  // The hub writes match.ended to the person who left too, so an ending is news only while this view was still in the conversation.
  const ended = prev.phase === 'matched' ? s.ended : null;
  // An idle answer after an ending is the server forgetting the mailbox, not news: the ending stays up until the person moves on.
  const phase = ended || (s.state === 'idle' && prev.phase === 'ended') ? 'ended' : s.state;
  const peer = m.peer?.displayName ?? (phase === 'ended' ? prev.peer : null);
  const lines = s.state === 'matched' ? m.lines : prev.lines;
  const theirs = (l: FyreflockLine[]) => l.filter((x) => x.from === 'them').length;
  const lastMine = lines.length > 0 && lines[lines.length - 1]!.from === 'me';
  const pv = m.pendingVideo ?? null;
  const video: FyreflockView['video'] = pv
    ? {
        peer: pv.peerName,
        stage: pv.youAccepted && pv.theyAccepted ? 'agreed' : pv.youAccepted ? 'waiting' : 'asked',
        youInvited: pv.youInvited,
      }
    : null;
  // An invite that went with no word from the server ran out, or became the call.
  const closed = prev.video && !video && !s.ended && s.notices.length === 0 ? 'The video invite closed.' : null;
  return {
    ...prev,
    video,
    phase,
    peer,
    viaAgent: m.peer?.viaAgent === true,
    lines,
    queue: { agent: m.queue.agentWaiting, text: m.queue.textWaiting },
    receipt: !lastMine ? null : m.readSeq >= m.deliveredSeq && m.deliveredSeq > 0 ? 'Read' : m.deliveredSeq > 0 ? 'Delivered' : 'Sent',
    note: ended ? endedNote(ended, peer) : (s.notices[s.notices.length - 1] ?? closed ?? (phase === 'matched' ? null : prev.note)),
    unread: prev.unread + Math.max(0, theirs(lines) - theirs(prev.lines)),
    reconnecting: false,
  };
}

const statusFor = (v: FyreflockView) =>
  v.phase === 'matched'
    ? v.reconnecting
      ? `reconnecting to @${v.peer}…`
      : `talking to @${v.peer}`
    : v.phase === 'searching'
      ? 'looking for someone'
      : undefined;

/**
 * The loop lives in module variables on purpose: a reload drops the old
 * environment's timers, so a generation counter is enough to make sure only
 * the newest loop ever writes the view.
 */
let generation = 0;
let timer: { cancel: () => void } | null = null;
let wantJoin = false;

async function apply($: EngineInterface, s: Snapshot): Promise<void> {
  const before = await read($, view);
  const after = fromSnapshot(before, s);
  await update($, view, () => after);
  $.ui.status(statusFor(after));
  if (after.unread > before.unread && after.peer) {
    const last = after.lines[after.lines.length - 1];
    if (last) $.ui.toast(`@${after.peer}: ${last.body}`);
  }
  if (after.video?.stage === 'asked' && before.video?.stage !== 'asked') {
    $.ui.toast(`@${after.video.peer} wants to video call. Answer in the Fyreflock pane.`);
  }
}

/** Where the call opens: the site the token belongs to, tagged with where the visit came from. */
async function callUrl($: EngineInterface): Promise<string> {
  return `${await site($)}/handoff?utm_source=claude`;
}

/**
 * Answer a video invite. The call itself is never here: a terminal has no
 * camera, so a yes is followed by a link to the call in the browser, which is
 * where the video goes, straight between the two browsers.
 */
async function answerVideo($: EngineInterface, yes: boolean): Promise<string> {
  try {
    const s = (await callTool($, 'fyreflock_app_video', { answer: yes ? 'accept' : 'decline' })) as unknown as Snapshot;
    await apply($, { ...s, ended: null, notices: yes ? [] : ['You said no. The conversation carries on.'] });
    return yes ? `Accepted. Open ${await callUrl($)} to join the call.` : 'Declined.';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await update($, view, (x) => ({ ...x, video: null, note: message }));
    return `Not answered: ${message}`;
  }
}

function stopLoop(): void {
  generation += 1;
  timer?.cancel();
  timer = null;
}

async function tick($: EngineInterface, mine: number): Promise<void> {
  if (mine !== generation) return;
  let delay = POLL_GAP_MS;
  try {
    const join = wantJoin;
    wantJoin = false;
    // `pane` is how the server knows this pane is live, so a chat box this same Claude Code mounts folds itself away.
    const s = (await callTool($, 'fyreflock_app_wait', { join, budget_ms: WAIT_MS, pane: true })) as unknown as Snapshot;
    if (mine !== generation) return;
    await apply($, s);
    if (s.state === 'idle' && !wantJoin) delay = IDLE_POLL_MS;
  } catch (err) {
    if (mine !== generation) return;
    const message = messageOf(err);
    if (!(await signedIn($))) {
      // Retrying cannot help a sign-in that is gone: the pane goes back to its Sign in button.
      stopLoop();
      await update($, view, (): FyreflockView => ({ ...EMPTY, note: message }));
      $.ui.status(undefined);
      return;
    }
    // A dropped poll mid-conversation is the widget's reconnecting state: the next answer that lands clears it.
    const v = await update($, view, (x): FyreflockView => ({ ...x, phase: x.phase === 'searching' ? 'idle' : x.phase, note: message, reconnecting: x.phase === 'matched' }));
    $.ui.status(statusFor(v));
    delay = ERROR_POLL_MS;
  }
  if (mine === generation) timer = $.clock.after(delay, () => void tick($, mine));
}

function startLoop($: EngineInterface): void {
  stopLoop();
  void tick($, generation);
}

/**
 * The device code of a sign-in under way. A secret, since whoever holds it
 * receives the tokens once the person presses Allow, so a module variable and
 * never the view. A hot reload loses it; the pane then asks for a new link.
 */
let device: { code: string; every: number; until: number } | null = null;
let deviceTimer: { cancel: () => void } | null = null;

/**
 * Sign in by device flow: a mod can neither take a browser callback nor use
 * Claude Code's own sign-in, so the server parks the request, the pane shows
 * its link, and the person presses Allow on fyreflock.com.
 */
async function signIn($: EngineInterface): Promise<void> {
  deviceTimer?.cancel();
  device = null;
  try {
    const r = await oauth($, '/oauth/device', {});
    const code = r.body.device_code;
    const link = r.body.verification_uri_complete;
    const userCode = r.body.user_code;
    if (!r.ok || typeof code !== 'string' || typeof link !== 'string' || typeof userCode !== 'string') throw new Error(String(r.body.error_description ?? `Fyreflock answered ${r.status}.`));
    const d = { code, every: Number(r.body.interval ?? 5) * 1000, until: (await $.clock.now()) + Number(r.body.expires_in ?? 900) * 1000 };
    device = d;
    await update($, view, (v): FyreflockView => ({ ...v, link, userCode, note: null }));
    deviceTimer = $.clock.after(d.every, () => void pollSignIn($, d));
  } catch (err) {
    await update($, view, (v): FyreflockView => ({ ...v, link: null, note: messageOf(err) }));
  }
}

/** Keeps polling through dropped requests and slow-downs; any other refusal, or the link running out, ends it. */
async function pollSignIn($: EngineInterface, d: { code: string; every: number; until: number }): Promise<void> {
  let r: Awaited<ReturnType<typeof oauth>> | null = null;
  try {
    r = await oauth($, '/oauth/token', { grant_type: DEVICE_GRANT, device_code: d.code });
  } catch {
    // Not an answer: the link is still good, so ask again.
  }
  if (d !== device) return;
  if (r?.ok && typeof r.body.access_token === 'string') {
    device = null;
    await keep($, r.body);
    await update($, view, (v): FyreflockView => ({ ...v, phase: 'idle', link: null, note: null }));
    startLoop($);
    return;
  }
  const error = r?.body.error;
  if (error === 'slow_down') d.every += 5_000;
  const ended =
    typeof error === 'string' && error !== 'authorization_pending' && error !== 'slow_down'
      ? String(r?.body.error_description ?? 'Sign-in did not finish.')
      : (await $.clock.now()) >= d.until
        ? 'The sign-in link expired.'
        : null;
  if (ended) {
    device = null;
    await update($, view, (v): FyreflockView => ({ ...v, link: null, note: ended }));
    return;
  }
  deviceTimer = $.clock.after(d.every, () => void pollSignIn($, d));
}

async function open($: EngineInterface): Promise<void> {
  const ready = await signedIn($);
  await update($, view, (v): FyreflockView => (v.phase === 'off' && ready ? { ...v, phase: 'idle' } : v));
  await $.ui.open({ id: PANE, title: 'Fyreflock', columns: 44 });
  if (!ready) {
    // A link already on screen stays good for its quarter hour; asking again would strand the browser holding it.
    if (!device) await signIn($);
    return;
  }
  if (timer === null) startLoop($);
}

async function start($: EngineInterface): Promise<string> {
  if (!(await signedIn($))) return 'Sign in first: open the link in the Fyreflock pane and press Allow.';
  wantJoin = true;
  $.ui.status(statusFor(await update($, view, (v): FyreflockView => ({ ...v, phase: 'searching', lines: [], receipt: null, note: null, unread: 0 }))));
  startLoop($);
  return 'Looking for someone on Fyreflock.';
}

async function leave($: EngineInterface, next: boolean): Promise<string> {
  const v = await read($, view);
  if (v.phase !== 'matched' && v.phase !== 'searching' && !next) return 'Nothing to leave.';
  const ending = v.phase === 'matched' && !next;
  await update($, view, (x): FyreflockView => ({
    ...x,
    phase: next ? 'searching' : ending ? 'ended' : 'idle',
    lines: next ? [] : x.lines,
    receipt: null,
    note: ending ? 'You left the campfire' : null,
    unread: 0,
  }));
  try {
    const s = (await callTool($, 'fyreflock_app_leave', { next })) as unknown as Snapshot;
    await apply($, s);
  } catch (err) {
    await update($, view, (x) => ({ ...x, note: err instanceof Error ? err.message : String(err) }));
  }
  startLoop($);
  return next ? 'Skipped. Looking for somebody else.' : 'Left the conversation.';
}

async function say($: EngineInterface, text: string): Promise<string> {
  const body = text.trim();
  if (!body) return 'Nothing to send.';
  const v = await read($, view);
  if (v.phase !== 'matched') return 'Nobody is on the other end. Say /fyreflock start first.';
  await update($, view, (x): FyreflockView => ({ ...x, lines: [...x.lines, { from: 'me', body, at: Date.now() }], receipt: 'Sending', unread: 0 }));
  try {
    await callTool($, 'fyreflock_app_say', { text: body });
    await update($, view, (x) => ({ ...x, receipt: 'Sent' }));
    return `Sent: ${body}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await update($, view, (x) => ({ ...x, lines: x.lines.slice(0, -1), receipt: null, note: message }));
    return `Not sent: ${message}`;
  }
}

async function status($: EngineInterface): Promise<string> {
  const v = await read($, view);
  const q = v.queue ? ` ${v.queue.agent} waiting via assistants, ${v.queue.text} in the text lobby.` : '';
  if (v.phase === 'off') return 'Fyreflock is not signed in: run /fyreflock and open the link it shows.';
  if (v.phase === 'matched') return `Talking to @${v.peer}${v.viaAgent ? ' (via an assistant)' : ''}, ${v.lines.length} lines.${q}`;
  if (v.phase === 'searching') return `Looking for someone.${q}`;
  return `No conversation open.${q}`;
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    // A hot reload runs this again with the session's state intact and the old
    // loop gone: a conversation that was live keeps its poll.
    const v = await read($, view);
    if (v.phase === 'matched' || v.phase === 'searching') startLoop($);
    // The device code went with the old module, so its link would wait forever: back to the Sign in button.
    if (v.link && !device) await update($, view, (x): FyreflockView => ({ ...x, link: null }));
    await $.command.register({
      name: 'fyreflock',
      description: 'Talk to a stranger on Fyreflock in a pane: start, next, leave, status, or a line to send.',
      argumentHint: 'start | next | leave | status | <message>',
      immediate: true,
    });
    return next(e);
  });

  on('command.run', { command: 'fyreflock' }, async ($, e) => {
    const arg = e.args.trim();
    const word = arg.toLowerCase();
    if (word === '' || word === 'open') {
      await open($);
      const { phase, link, userCode } = await read($, view);
      // In the transcript too, where the link is clickable even on a surface that seats no pane.
      if (phase === 'off' && link) return { text: `Sign in to Fyreflock: open ${link}, type the code ${userCode} on the page, and press Allow. The pane picks it up from there.` };
      return { text: 'Fyreflock pane opened. /fyreflock start finds someone; anything else you give /fyreflock is sent as written.' };
    }
    if (word === 'start') {
      await open($);
      return { text: await start($) };
    }
    if (word === 'next') return { text: await leave($, true) };
    if (word === 'leave' || word === 'stop') return { text: await leave($, false) };
    if (word === 'status') return { text: await status($) };
    return { text: await say($, arg) };
  });

  on('prompt.submit', async ($, e, next) => {
    await update($, view, (v) => (v.unread ? { ...v, unread: 0 } : v));
    return next(e);
  });

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const v = await read($, view);
    // A closed pane with nothing open stops the loop; a live conversation keeps polling so the band can still say who replied.
    if (v.phase !== 'matched' && v.phase !== 'searching') stopLoop();
    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e);
    const { Box, Text, Button, Link } = table;
    // Mobile has no text field; the pane still shows the conversation there.
    const Input = (table as { Input?: ElementConstructor<InputProps> }).Input ?? null;
    const v = await read($, view);
    const mood = moodOf(v);
    const live = v.phase === 'matched';
    const rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24;
    const shown = v.lines.slice(-Math.max(3, rows - 9));
    const earlier = live || mood === 'ended' ? v.lines.length - shown.length : 0;
    const around = v.queue ? v.queue.agent + v.queue.text : null;
    const meta = live ? 'Fyreflock' : mood === 'idle' && around !== null ? `${around} by the fire` : mood === 'searching' ? 'Looking' : mood === 'ended' ? 'Chat ended' : '';
    return (
      <Box flexDirection="column" gap={0}>
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Text color={MOOD[mood]}>●</Text>
            <Text bold>{live ? `@${v.peer}` : 'Fyreflock'}</Text>
          </Box>
          <Text dimColor>{meta}</Text>
        </Box>
        {mood === 'matched' && <Text dimColor>{`Camera checked · ${v.viaAgent ? 'reads through an assistant' : 'Relayed by Fyreflock'}`}</Text>}
        {mood === 'reconnecting' && <Text color="claude">Reconnecting…</Text>}
        {/* The widget's glow, as a rule under the header in the state's colour. */}
        <Text color={MOOD[mood]}>{'─'.repeat(e.props.bodyColumns)}</Text>
        {mood === 'off' && v.link && (
          <Box flexDirection="column" gap={1}>
            <Text bold>Sign in to Fyreflock</Text>
            <Text wrap="wrap">Open this link, sign in or sign up, and press Allow:</Text>
            {/* No label: the address is the text, so a terminal that cannot open links still lets it be copied. */}
            <Link href={v.link} />
            {/* Typed, not carried in the link: a forwarded link used to let whoever opened it approve somebody else's pane. */}
            <Box flexDirection="column">
              <Text wrap="wrap">Type this code on the page, then press Allow:</Text>
              <Text bold>{v.userCode}</Text>
            </Box>
            <Text dimColor>Waiting for you to press Allow…</Text>
          </Box>
        )}
        {mood === 'off' && !v.link && (
          <Box flexDirection="column" gap={1}>
            <Text wrap="wrap">Sign in to talk one to one with a real person.</Text>
            <Box>
              <Button key="signin" hotkey="s" variant="primary" onPress={() => void signIn($)}>
                Sign in
              </Button>
            </Box>
          </Box>
        )}
        {mood === 'idle' && <Text bold>Find your flock</Text>}
        {mood === 'idle' && <Text wrap="wrap">Talk one to one with a real person who passed a live camera check. No bots, and you can leave whenever you like.</Text>}
        {mood === 'searching' && <Text bold>Finding someone for you</Text>}
        {/* The searcher is in the queue too, so the others are one fewer. */}
        {mood === 'searching' && <Text dimColor>{`Matching on anything${around === null ? '' : ` · ${Math.max(0, around - 1)} others looking`}`}</Text>}
        {earlier > 0 && (
          <Box justifyContent="center">
            <Text dimColor>{`${earlier} earlier ${earlier === 1 ? 'line' : 'lines'}`}</Text>
          </Box>
        )}
        {(live || mood === 'ended') &&
          shown.map((l, i) => (
            <Box
              justifyContent={l.from === 'me' ? 'flex-end' : 'flex-start'}
              marginTop={i > 0 && shown[i - 1]!.from !== l.from ? 1 : 0}
              paddingLeft={l.from === 'me' ? 6 : 0}
              paddingRight={l.from === 'me' ? 0 : 6}
            >
              <Text wrap="wrap" dimColor={mood === 'ended'} color={l.from === 'me' ? 'suggestion' : undefined}>
                {l.body}
              </Text>
            </Box>
          ))}
        {v.receipt && live && (
          <Box justifyContent="flex-end" gap={1}>
            <Text color="warning">✓✓</Text>
            <Text dimColor>{v.receipt}</Text>
          </Box>
        )}
        {v.video && live && v.video.stage === 'asked' && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="warning">{`@${v.video.peer} wants to video call.`}</Text>
            <Box gap={1}>
              <Button key="video-yes" hotkey="a" variant="primary" onPress={() => void answerVideo($, true)}>
                Accept
              </Button>
              <Button key="video-no" hotkey="d" onPress={() => void answerVideo($, false)}>
                Decline
              </Button>
            </Box>
          </Box>
        )}
        {v.video && live && v.video.stage !== 'asked' && (
          <Box flexDirection="column" marginTop={1}>
            <Text wrap="wrap">
              {v.video.stage === 'agreed'
                ? 'You both said yes.'
                : v.video.youInvited
                  ? `Invite sent. Waiting for @${v.video.peer} to accept.`
                  : `You said yes. Waiting for @${v.video.peer}.`}
            </Text>
            <Link href={await callUrl($)}>Open the call in your browser</Link>
          </Box>
        )}
        {mood === 'reconnecting' && <Text color="claude" wrap="wrap">{`↻ Lost the connection to @${v.peer}. Reconnecting…`}</Text>}
        {mood === 'ended' && (
          <Box marginTop={1}>
            <Text bold>{v.note ?? 'The conversation ended.'}</Text>
          </Box>
        )}
        {mood === 'ended' && <Text dimColor>{`${v.lines.length} ${v.lines.length === 1 ? 'line' : 'lines'} · Thanks for keeping it kind.`}</Text>}
        {v.note && mood !== 'ended' && mood !== 'reconnecting' && (
          <Text color="warning" wrap="wrap">
            {v.note}
          </Text>
        )}
        {Input && live && <Input key="say" placeholder={`Message @${v.peer}`} submitLabel="send" autoFocus onSubmit={(text) => void say($, text)} />}
        <Box gap={1} marginTop={1}>
          {(mood === 'idle' || mood === 'ended') && (
            <Button key="start" hotkey="s" variant="primary" onPress={() => void start($)}>
              {mood === 'ended' ? 'Find someone new' : 'Start'}
            </Button>
          )}
          {live && (
            <Button key="next" hotkey="n" onPress={() => void leave($, true)}>
              Next person →
            </Button>
          )}
          {(live || mood === 'searching') && (
            <Button key="leave" hotkey="l" onPress={() => void leave($, false)}>
              <Text color={live ? 'error' : undefined}>{live ? 'Leave' : 'Cancel'}</Text>
            </Button>
          )}
        </Box>
        {mood === 'idle' && <Text dimColor>Text only · leave any time</Text>}
        {mood === 'searching' && <Text dimColor>You can keep talking to Claude meanwhile</Text>}
        {live && <Text dimColor>Goes to them directly, not to Claude</Text>}
      </Box>
    );
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view);
    const quiet = e.props.hasSurvey || e.props.isWorking || (await read($, bandHidden)) || v.phase === 'off' || v.phase === 'idle';
    if (quiet) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const mood = moodOf(v);
    const label =
      mood === 'reconnecting'
        ? `Fyreflock: lost the connection to @${v.peer}, reconnecting…`
        : mood === 'matched' && v.video?.stage === 'asked'
          ? `Fyreflock: @${v.video.peer} wants to video call`
          : mood === 'matched'
            ? `Fyreflock: talking to @${v.peer}${v.unread ? `, ${v.unread} new ${v.unread === 1 ? 'line' : 'lines'}` : ''}`
            : mood === 'searching'
              ? 'Fyreflock: looking for someone'
              : `Fyreflock: ${v.note ?? 'the conversation ended'}`;
    return (
      <Box gap={1}>
        <Text color={MOOD[mood]}>●</Text>
        <Text>{label}</Text>
        <Button key="open" plain onPress={() => void open($)}>
          open
        </Button>
        <Button key="hide" plain onPress={() => update($, bandHidden, () => true)}>
          hide
        </Button>
      </Box>
    );
  });
};
