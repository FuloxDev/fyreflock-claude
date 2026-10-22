/** One relayed line as the pane draws it. `me` is the person at this keyboard. */
export type FyreflockLine = { from: 'me' | 'them'; body: string; at: number };

/**
 * Everything the pane and the band draw from, redrawn whole from each
 * `fyreflock_app_wait` snapshot. Held in `$.state` rather than a module
 * variable so a hot reload of the mod keeps the conversation on screen.
 */
export type FyreflockView = {
  /** `off` is not signed in yet; `ended` keeps the last lines up with the reason. */
  phase: 'off' | 'idle' | 'searching' | 'matched' | 'ended';
  /** The sign-in link while the pane waits for the person to press Allow in their browser. */
  link: string | null;
  /** The code the consent page must show too, beside `link`; only read while `link` is set. */
  userCode: string | null;
  me: string | null;
  peer: string | null;
  viaAgent: boolean;
  lines: FyreflockLine[];
  queue: { agent: number; text: number } | null;
  receipt: string | null;
  note: string | null;
  /** Lines from them since the person last typed or pressed anything here. */
  unread: number;
  /** The last poll failed mid-conversation; the next answer that lands clears it. */
  reconnecting: boolean;
  /**
   * A video invite with the person on the other end. `asked` is theirs and ours
   * to answer, `waiting` is a yes on one side only, `agreed` is both.
   */
  video: { peer: string; stage: 'asked' | 'waiting' | 'agreed'; youInvited: boolean } | null;
};

declare module 'claude-code' {
  interface PluginState {
    fyreflock: { view: FyreflockView; bandHidden: boolean };
  }
}
