// The gesture that lets a terminal take focus as it attaches (W57): spent once, within GESTURE_MS, and
// only while focus is in the view, on what was pressed, or nowhere because that has gone.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { focusGesture, GESTURE_MS, spendGesture } from './focusGesture.js';

const AT = 1_000_000;

let view: HTMLElement;
let inside: HTMLButtonElement;
let row: HTMLButtonElement;
let filter: HTMLInputElement;

beforeEach(() => {
  view = document.createElement('section');
  inside = document.createElement('button');
  view.append(inside);
  row = document.createElement('button');
  filter = document.createElement('input');
  document.body.append(view, row, filter);
});

afterEach(() => {
  (document.activeElement as HTMLElement | null)?.blur?.();
  document.body.replaceChildren();
});

describe('spendGesture', () => {
  it('says no with no gesture, as for a view the URL, a reload, back or a step opened', () => {
    inside.focus();
    expect(spendGesture(undefined, view, AT)).toBe(false);
  });

  it('says yes once, with focus in the view, and no after that, whatever focus does', () => {
    const gesture = focusGesture(row, AT);
    inside.focus();
    expect(spendGesture(gesture, view, AT + 10)).toBe(true);
    expect(gesture.used).toBe(true);
    expect(spendGesture(gesture, view, AT + 20)).toBe(false);
  });

  it('is spent by asking, even when the answer is no', () => {
    const gesture = focusGesture(row, AT);
    filter.focus();
    expect(spendGesture(gesture, view, AT)).toBe(false);
    inside.focus();
    expect(spendGesture(gesture, view, AT)).toBe(false);
  });

  it(`lasts ${GESTURE_MS} ms: yes at that age, no a millisecond later, and no for a clock that went backwards`, () => {
    inside.focus();
    expect(spendGesture(focusGesture(row, AT), view, AT + GESTURE_MS)).toBe(true);
    expect(spendGesture(focusGesture(row, AT), view, AT + GESTURE_MS + 1)).toBe(false);
    expect(spendGesture(focusGesture(row, AT), view, AT - 1)).toBe(false);
  });

  it('says yes with focus on what was pressed, outside the view, such as the row', () => {
    row.focus();
    expect(spendGesture(focusGesture(row, AT), view, AT)).toBe(true);
  });

  it('says no with focus elsewhere, as in the filter, so what is typed there stays there', () => {
    filter.focus();
    expect(spendGesture(focusGesture(row, AT), view, AT)).toBe(false);
  });

  it('says no with focus nowhere while what was pressed is still there, as after a click on the page itself', () => {
    expect(document.activeElement).toBe(document.body);
    expect(spendGesture(focusGesture(row, AT), view, AT)).toBe(false);
    expect(spendGesture(focusGesture(undefined, AT), view, AT)).toBe(false);
  });

  it('says yes with focus nowhere because what was pressed has gone, as Attach again goes once the attach starts', () => {
    const attachAgain = document.createElement('button');
    view.append(attachAgain);
    attachAgain.focus();
    const gesture = focusGesture(attachAgain, AT);
    attachAgain.remove();
    expect(spendGesture(gesture, view, AT)).toBe(true);
  });

  it('says no with no view to look in, unless focus is on what was pressed', () => {
    inside.focus();
    expect(spendGesture(focusGesture(row, AT), null, AT)).toBe(false);
    row.focus();
    expect(spendGesture(focusGesture(row, AT), null, AT)).toBe(true);
  });
});
