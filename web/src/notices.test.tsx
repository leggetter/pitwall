// THIRD_PARTY_NOTICES.md against what the web UI bundles, so a version bump can't leave it behind.
import interLicense from '@fontsource/inter/LICENSE?raw';
import interManifest from '@fontsource/inter/package.json?raw';
import monoLicense from '@fontsource/jetbrains-mono/LICENSE?raw';
import monoManifest from '@fontsource/jetbrains-mono/package.json?raw';
import { describe, expect, it } from 'vitest';
import notices from '../../THIRD_PARTY_NOTICES.md?raw';
import iconsLicense from './icons/LICENSE?raw';
import pathsSource from './icons/paths.ts?raw';

const versionOf = (manifest: string) => (JSON.parse(manifest) as { version: string }).version;

describe('THIRD_PARTY_NOTICES.md', () => {
  it.each([
    ['Inter', interLicense],
    ['JetBrains Mono', monoLicense],
    ['Material Symbols', iconsLicense],
  ])('has the licence for %s in full', (_name, licence) => {
    expect(licence.length).toBeGreaterThan(1000);
    expect(notices).toContain(licence.trimEnd());
  });

  it('names the font versions that are installed', () => {
    expect(notices).toContain(`\`@fontsource/inter\` ${versionOf(interManifest)}`);
    expect(notices).toContain(`\`@fontsource/jetbrains-mono\` ${versionOf(monoManifest)}`);
  });

  it('names the icon release that paths.ts came from', () => {
    const version = /@material-symbols\/svg-400@(\d+\.\d+\.\d+)/.exec(pathsSource)?.[1];
    expect(version).toBeDefined();
    expect(notices).toContain(`\`@material-symbols/svg-400\` ${version}`);
  });
});
