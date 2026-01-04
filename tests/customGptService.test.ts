import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CustomGptService } from '../src/customGptService';

describe('CustomGptService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to env list', async () => {
    const service = new CustomGptService({ envList: 'alpha,beta' });
    const list = await service.load();
    expect(list.map((g) => g.id)).toEqual(['alpha', 'beta']);
  });

  it('falls back to defaults when nothing provided', async () => {
    const service = new CustomGptService({});
    const list = await service.load();
    expect(list.length).toBeGreaterThan(0);
  });

  it('prefers API response when available', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt_1', display_name: 'My GPT' }] })
    });
    // @ts-expect-error override global fetch for test
    global.fetch = fetchMock;

    const service = new CustomGptService({ apiKey: 'k', baseUrl: 'https://example.com' });
    const list = await service.load();
    expect(fetchMock).toHaveBeenCalled();
    expect(list).toEqual([{ id: 'gpt_1', label: 'My GPT' }]);
  });
});
