// @vitest-environment node
// The gallery is in dev builds only (W19): `npm run build` leaves out its code, its fixtures and its
// stylesheet, and `npm run dev`'s development mode keeps them. Both builds run in memory with the
// real vite.config.ts.
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CONFIG = fileURLToPath(new URL('../../../vite.config.ts', import.meta.url));

/** Every file the web build would write, by name, with its text. */
async function webBuild(mode: 'production' | 'development'): Promise<Map<string, string>> {
  // As npm run build has it: vitest sets NODE_ENV to test, which would make this a development build of React.
  vi.stubEnv('NODE_ENV', 'production');
  const result = await build({ configFile: CONFIG, mode, logLevel: 'silent', build: { write: false } });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const files = new Map<string, string>();
  for (const { output } of outputs) {
    for (const file of output) {
      const text = file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString('latin1');
      files.set(file.fileName, text);
    }
  }
  return files;
}

/** Text that only the gallery has: its route, its title, its class names and its fixtures' names. */
const GALLERY_TEXT = ['uikit', 'UI kit', 'pitwall-test-'];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the gallery in the web build', () => {
  it('is left out of npm run build: no gallery chunk or stylesheet, and none of its text anywhere', async () => {
    const files = await webBuild('production');

    // The build itself happened: the app's entry is there.
    expect([...files.keys()].some((name) => /^assets\/index-.*\.js$/.test(name))).toBe(true);
    expect([...files.keys()].filter((name) => /gallery/i.test(name))).toEqual([]);
    for (const [name, text] of files) {
      for (const wanted of GALLERY_TEXT) expect(text.includes(wanted), `${wanted} in ${name}`).toBe(false);
    }
  }, 60_000);

  it("is in npm run dev's development build, as a chunk of its own", async () => {
    const files = await webBuild('development');

    const chunks = [...files.keys()].filter((name) => /^assets\/Gallery-.*\.js$/.test(name));
    expect(chunks).toHaveLength(1);
    expect(files.get(chunks[0]!)).toContain('pitwall UI kit');
    expect([...files.keys()].some((name) => /^assets\/Gallery-.*\.css$/.test(name))).toBe(true);
    // The entry only knows the chunk's name, to load it at #uikit.
    const entry = [...files].find(([name]) => /^assets\/index-.*\.js$/.test(name))?.[1] ?? '';
    expect(entry).not.toContain('pitwall-test-');
  }, 60_000);
});
