import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Basic Test', () => {
  it('should pass', () => {
    assert.equal(1, 1);
  });
});

describe('Server Test', () => {
  it('should start the server', async () => {
    const server = await import('../server.ts');
    await server.start();
    assert.ok(server);
  });
});

export {}; // Add this line to make the file a module

// Ensure the file is treated as a module by adding a default export
export default {};