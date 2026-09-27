import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { forgetKept } from "../src/jobs";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { pywebview?: unknown }).pywebview;
  localStorage.clear();
  forgetKept();
});

// jsdom has no layout: every element measures 0x0, so the virtualised result
// grid would render no rows. Give elements a viewport-sized box.
HTMLElement.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600,
     width: 1200, height: 600, toJSON: () => ({}) }) as DOMRect;
Object.defineProperty(HTMLElement.prototype, "offsetHeight",
                      { configurable: true, get: () => 600 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth",
                      { configurable: true, get: () => 1200 });
// CodeMirror measures text ranges; jsdom's Range has no geometry at all.
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0,
     width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
// jsdom does not scroll; the app calls scrollIntoView to bring a section in.
Element.prototype.scrollIntoView = () => {};
