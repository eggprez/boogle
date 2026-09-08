import { describe, expect, it } from 'vitest';
import { validHost } from '../src/favicons.js';
import { isPrivateHost } from '../src/overview/pages.js';

describe('validHost', () => {
  it('accepts normal hostnames and strips www', () => {
    expect(validHost('www.Example.com')).toBe('example.com');
    expect(validHost('docs.rs')).toBe('docs.rs');
  });
  it('rejects junk, paths, and private hosts', () => {
    for (const bad of ['', 'localhost', 'example.com/x', 'a b.com', '192.168.1.5', '10.0.0.1', 'host', 'x'.repeat(300), '-bad.com', 'searxng'])
      expect(validHost(bad), bad).toBeNull();
  });
});

describe('isPrivateHost', () => {
  it('flags loopback, RFC1918, link-local, and bare names', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.9.9', '192.168.0.1', '169.254.1.1', 'searxng', 'foo.local', '[::1]'])
      expect(isPrivateHost(h), h).toBe(true);
  });
  it('allows public hosts', () => {
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1']) expect(isPrivateHost(h), h).toBe(false);
  });
});
