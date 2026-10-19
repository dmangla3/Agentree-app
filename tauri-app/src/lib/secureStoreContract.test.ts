import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('native secure store writes', () => {
  test('trusts a successful Keychain write without reading the secret back', () => {
    const source = readFileSync(join(process.cwd(), 'src-tauri/src/secure_store.rs'), 'utf8');

    expect(source).not.toContain('set_password_verified');
    expect(source).toMatch(/entry\s*\.set_password\(password\)/);
    expect(source).not.toContain('stored_password');
  });
});
