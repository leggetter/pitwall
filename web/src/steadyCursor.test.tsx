// The terminal's cursor never blinks (W45), against the real xterm.js 6.0.0, not opened: what a program
// can send to make it blink, DECSCUSR (CSI Ps SP q) and DECSET 12 (CSI ? 12 h), and keepCursorSteady()
// holding each one off while keeping the shape it asks for.
//
// DECSCUSR's blink lives only in xterm.js's own state, which its public API doesn't show, so the
// steps read it there (`decPrivateModes`) to prove what xterm.js would draw. The code under test uses
// only the public parser hooks and options. Everything else is read through the terminal's own
// answers: DECRQM for a mode, and DECRQSS for the cursor style.

import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it } from 'vitest';
import { BLINK_MODE, CURSOR_SHAPE, keepCursorSteady, requestedCursorShape } from './xterm.js';

const ESC = '\u001b';
const CSI = `${ESC}[`;
const DCS = `${ESC}P`;
const ST = `${ESC}\\`;

/** DECSCUSR: the cursor style, `CSI Ps SP q`; none for no parameter. */
const decscusr = (ps?: number) => `${CSI}${ps ?? ''} q`;

interface Terminals {
  terminal: Terminal;
  replies: string[];
}

const made: Terminal[] = [];

function terminal(steady: boolean): Terminals {
  const created = new Terminal({ cursorBlink: false, cursorStyle: CURSOR_SHAPE, allowProposedApi: false });
  made.push(created);
  if (steady) keepCursorSteady(created);
  const replies: string[] = [];
  created.onData((data) => replies.push(data));
  return { terminal: created, replies };
}

/** Writes `data`, waits for xterm.js to parse it, then for a microtask, as the page's next frame would. */
async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(data, resolve));
  await Promise.resolve();
}

/** xterm.js's own cursor state, which outranks its options when it draws the cursor (DomRenderer). */
function drawn(term: Terminal): { blink: boolean | undefined; style: string | undefined } {
  const modes = (term as unknown as { _core: { coreService: { decPrivateModes: { cursorBlink?: boolean; cursorStyle?: string } } } })._core.coreService
    .decPrivateModes;
  return {
    blink: modes.cursorBlink ?? term.options.cursorBlink,
    style: modes.cursorStyle ?? term.options.cursorStyle,
  };
}

/** The terminal's answer to DECRQM for a private mode: 1 set, 2 reset. */
async function mode(t: Terminals, value: number): Promise<number | undefined> {
  t.replies.length = 0;
  await write(t.terminal, `${CSI}?${value}$p`);
  const match = new RegExp(`\\u001b\\[\\?${value};(\\d)\\$y`).exec(t.replies.join(''));
  return match ? Number(match[1]) : undefined;
}

/** The terminal's answer to DECRQSS for the cursor style: 2 steady block, 4 steady underline, 6 steady bar; one less blinks. */
async function reportedStyle(t: Terminals): Promise<number | undefined> {
  t.replies.length = 0;
  await write(t.terminal, `${DCS}$q q${ST}`);
  const match = /\u001bP1\$r(\d) q/.exec(t.replies.join(''));
  return match ? Number(match[1]) : undefined;
}

afterEach(() => {
  for (const term of made.splice(0)) term.dispose();
});

describe('what xterm.js 6.0.0 does on its own (why W45 needs more than cursorBlink: false)', () => {
  it.each([
    ['1, a blinking block', 1, 'block'],
    ['3, a blinking underline', 3, 'underline'],
    ['5, a blinking bar', 5, 'bar'],
  ] as const)('DECSCUSR %s turns the blink on, over the option', async (_, ps, style) => {
    const { terminal: term } = terminal(false);
    await write(term, decscusr(ps));
    expect(term.options.cursorBlink).toBe(false);
    expect(drawn(term)).toEqual({ blink: true, style });
  });

  it('DECSCUSR 7, which it doesn’t define, turns the blink on too, as an odd value, without a shape', async () => {
    const { terminal: term } = terminal(false);
    await write(term, decscusr(7));
    expect(drawn(term)).toEqual({ blink: true, style: CURSOR_SHAPE });
  });

  it('DECSCUSR with no parameter reads as 0, which resets to the options: no blink', async () => {
    const { terminal: term } = terminal(false);
    await write(term, decscusr(5));
    await write(term, decscusr());
    expect(drawn(term)).toEqual({ blink: false, style: CURSOR_SHAPE });
  });

  it('DECSET 12 turns the cursorBlink option on', async () => {
    const t = terminal(false);
    await write(t.terminal, `${CSI}?${BLINK_MODE}h`);
    expect(t.terminal.options.cursorBlink).toBe(true);
    expect(await mode(t, BLINK_MODE)).toBe(1);
  });
});

describe('keepCursorSteady', () => {
  it.each([
    ['none', undefined, 'block'],
    ['1, a blinking block', 1, 'block'],
    ['3, a blinking underline', 3, 'underline'],
    ['5, a blinking bar', 5, 'bar'],
  ] as const)('keeps the shape DECSCUSR %s asks for, steady', async (_, ps, style) => {
    const t = terminal(true);
    await write(t.terminal, decscusr(ps));
    expect(drawn(t.terminal)).toEqual({ blink: false, style });
    expect(t.terminal.options.cursorStyle).toBe(style);
    // The terminal answers that it's steady, as it is.
    expect(await reportedStyle(t)).toBe({ block: 2, underline: 4, bar: 6 }[style]);
  });

  it.each([
    [2, 'block'],
    [4, 'underline'],
    [6, 'bar'],
  ] as const)('keeps the shape of a steady DECSCUSR %i, steady', async (ps, style) => {
    const t = terminal(true);
    await write(t.terminal, decscusr(5));
    await write(t.terminal, decscusr(ps));
    expect(drawn(t.terminal)).toEqual({ blink: false, style });
  });

  it('puts the default shape back for DECSCUSR 0, and changes nothing for a value it doesn’t define, which xterm.js would make blink', async () => {
    const t = terminal(true);
    await write(t.terminal, decscusr(5));
    await write(t.terminal, decscusr(0));
    expect(drawn(t.terminal)).toEqual({ blink: false, style: CURSOR_SHAPE });
    await write(t.terminal, decscusr(3));
    await write(t.terminal, decscusr(7));
    expect(drawn(t.terminal)).toEqual({ blink: false, style: 'underline' });
  });

  it('turns DECSET 12 off again before a frame is drawn, and says so when asked', async () => {
    const t = terminal(true);
    await write(t.terminal, `${CSI}?${BLINK_MODE}h`);
    expect(t.terminal.options.cursorBlink).toBe(false);
    expect(drawn(t.terminal).blink).toBe(false);
    expect(await mode(t, BLINK_MODE)).toBe(2);
  });

  it('still applies the other modes in the same DECSET, as `CSI ? 12 ; 25 h` shows a hidden cursor', async () => {
    const t = terminal(true);
    await write(t.terminal, `${CSI}?25l`);
    expect(await mode(t, 25)).toBe(2);
    await write(t.terminal, `${CSI}?${BLINK_MODE};25h`);
    expect(await mode(t, 25)).toBe(1);
    expect(t.terminal.options.cursorBlink).toBe(false);
    // Hidden again in the same write, after it: the order is the program's.
    await write(t.terminal, `${CSI}?12;25h${CSI}?25l`);
    expect(await mode(t, 25)).toBe(2);
    expect(t.terminal.options.cursorBlink).toBe(false);
  });

  it('leaves a DECSET without 12 alone', async () => {
    const t = terminal(true);
    await write(t.terminal, `${CSI}?2004h`);
    expect(t.terminal.modes.bracketedPasteMode).toBe(true);
    expect(t.terminal.options.cursorBlink).toBe(false);
  });

  it('puts the default shape back on a full reset (RIS) and a soft reset (DECSTR), as xterm.js resets its own', async () => {
    const t = terminal(true);
    await write(t.terminal, decscusr(5));
    await write(t.terminal, `${ESC}c`);
    expect(drawn(t.terminal)).toEqual({ blink: false, style: CURSOR_SHAPE });
    await write(t.terminal, decscusr(4));
    await write(t.terminal, `${CSI}!p`);
    expect(drawn(t.terminal)).toEqual({ blink: false, style: CURSOR_SHAPE });
    // xterm.js's own reset still ran: the soft reset showed a hidden cursor.
    await write(t.terminal, `${CSI}?25l${CSI}!p`);
    expect(await mode(t, 25)).toBe(1);
  });

  it('lets xterm.js handle each again once disposed', async () => {
    const term = new Terminal({ cursorBlink: false });
    made.push(term);
    const steady = keepCursorSteady(term);
    steady.dispose();
    await write(term, decscusr(5));
    expect(drawn(term)).toEqual({ blink: true, style: 'bar' });
  });

  it('leaves the terminal alone once disposed, even for a DECSET 12 it saw just before', async () => {
    const term = new Terminal({ cursorBlink: false });
    made.push(term);
    const steady = keepCursorSteady(term);
    // Disposed in the write's callback, which xterm.js calls straight after parsing, before the microtask.
    await new Promise<void>((resolve) =>
      term.write(`${CSI}?12h`, () => {
        steady.dispose();
        resolve();
      }),
    );
    await Promise.resolve();
    expect(term.options.cursorBlink).toBe(true);
  });
});

describe('requestedCursorShape', () => {
  it.each([
    [[], 'block'],
    [[0], CURSOR_SHAPE],
    [[1], 'block'],
    [[2], 'block'],
    [[3], 'underline'],
    [[4], 'underline'],
    [[5], 'bar'],
    [[6], 'bar'],
    [[7], undefined],
    [[42], undefined],
    [[[1, 2]], undefined],
  ] as const)('reads %j as %s', (params, shape) => {
    expect(requestedCursorShape(params as unknown as (number | number[])[])).toBe(shape);
  });
});
