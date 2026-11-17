import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pluginDirArgs, pluginDirOf } from './pluginDir.js';

describe('pluginDirOf (W197)', () => {
  it('finds the repo’s plugin folder from this module’s place, whatever the working directory', () => {
    const dir = pluginDirOf();
    expect(dir).toBeDefined();
    expect(existsSync(path.join(dir ?? '', '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(path.isAbsolute(dir ?? '')).toBe(true);
  });

  it('is undefined where no plugin sits two folders up, and counts only a plugin.json that is a file', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-plugindir-'));
    try {
      mkdirSync(path.join(root, 'dist', 'server'), { recursive: true });
      const from = path.join(root, 'dist', 'server', 'pluginDir.js');
      expect(pluginDirOf(from)).toBeUndefined();
      mkdirSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'), { recursive: true });
      expect(pluginDirOf(from)).toBeUndefined();
      rmSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'), { recursive: true });
      writeFileSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'), '{}');
      expect(pluginDirOf(from)).toBe(path.join(root, 'plugin'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the copy a build makes in dist/plugin to plugin/ (W197 review, F3)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-plugindir-'));
    try {
      const from = path.join(root, 'dist', 'server', 'pluginDir.js');
      for (const dir of [path.join(root, 'plugin'), path.join(root, 'dist', 'plugin')]) {
        mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
        writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{}');
      }
      mkdirSync(path.join(root, 'dist', 'server'), { recursive: true });
      expect(pluginDirOf(from)).toBe(path.join(root, 'dist', 'plugin'));
      rmSync(path.join(root, 'dist', 'plugin'), { recursive: true });
      expect(pluginDirOf(from)).toBe(path.join(root, 'plugin'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gives the option as one argument', () => {
    expect(pluginDirArgs('/a b/plugin')).toEqual(['--plugin-dir=/a b/plugin']);
    expect(pluginDirArgs(undefined)).toEqual([]);
  });
});
