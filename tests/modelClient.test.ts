import { describe, expect, it } from 'vitest';
import { createModelClient } from '../src/modelClient';

describe('ModelClient (mock)', () => {
  it('includes custom GPT in mock response', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GPTSTUDIO_API_KEY;
    const client = createModelClient();
    const chunks: string[] = [];
    const response = await client.chat(
      {
        model: 'gpt-4.1',
        mode: 'chat',
        customGpt: 'my-custom',
        prompt: 'hello',
        context: { workspaceName: 'ws', files: [], openFiles: [] }
      },
      (chunk) => chunks.push(chunk)
    );
    expect(response).toContain('Custom GPT: my-custom');
    expect(chunks.join('')).toContain('Custom GPT: my-custom');
  });
});
