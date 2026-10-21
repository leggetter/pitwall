// The app's width (layout.ts): what's on screen, unless a transform scales it, as the #uikit gallery
// scales a window wider than its stage to fit (W34).
import { describe, expect, it } from 'vitest';
import { layoutFor, widthOf } from './layout.js';

/** An element whose box on screen is `onScreen` wide, and whose layout width is `laidOut`. */
function measured(onScreen: number, laidOut: number): HTMLElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ width: onScreen, height: 0, top: 0, left: 0, right: onScreen, bottom: 0, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(element, 'offsetWidth', { value: laidOut });
  return element;
}

describe('widthOf', () => {
  it('is the width on screen, exact, when nothing scales it', () => {
    expect(widthOf(measured(1199.5, 1200))).toBe(1199.5);
    expect(widthOf(measured(1280, 1280))).toBe(1280);
  });

  it('is the layout width when a transform scales it, so a scaled window keeps its own columns', () => {
    // A 1,280 px window at 0.66, as the gallery shows it at 900 px.
    expect(widthOf(measured(844.8, 1280))).toBe(1280);
    expect(layoutFor(widthOf(measured(844.8, 1280)))).toBe('three-columns');
  });

  it("is the window's width before the element is laid out", () => {
    expect(widthOf(null)).toBe(window.innerWidth);
    expect(widthOf(measured(0, 0))).toBe(window.innerWidth);
  });
});
