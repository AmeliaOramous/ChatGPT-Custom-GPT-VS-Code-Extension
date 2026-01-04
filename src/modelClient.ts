import { ContextBundle } from './context';

export type Mode = 'chat' | 'agent' | 'full-agent';

export type ChatRequest = {
  model: string;
  mode: Mode;
  customGpt?: string;
  prompt: string;
  context: ContextBundle;
};

export type ModelClient = {
  chat(request: ChatRequest, onChunk?: (chunk: string) => void): Promise<string>;
};

export function createModelClient(apiKey?: string, baseUrl?: string): ModelClient {
  const key = apiKey ?? process.env.OPENAI_API_KEY ?? process.env.GPTSTUDIO_API_KEY;
  const url = baseUrl ?? process.env.OPENAI_BASE_URL ?? process.env.GPTSTUDIO_API_BASE;

  if (key) {
    return new OpenAiModelClient(key, url);
  }

  return new MockModelClient();
}

class MockModelClient implements ModelClient {
  async chat(request: ChatRequest, onChunk?: (chunk: string) => void): Promise<string> {
    const { prompt, model, mode, context, customGpt } = request;
    const response = [
      `Model: ${model}`,
      `Mode: ${mode}`,
      `Custom GPT: ${customGpt ?? 'none'}`,
      `Workspace: ${context.workspaceName}`,
      `Files: ${context.files.slice(0, 5).join(', ') || 'None'}`,
      `Open files: ${context.openFiles.map((f) => f.path).join(', ') || 'None'}`,
      '',
      `Echo: ${prompt}`,
      '',
      'Mock client is active (set OPENAI_API_KEY to use a real model).'
    ].join('\n');

    // Simulate streaming chunks
    for (const part of response.split('\n')) {
      onChunk?.(part + '\n');
      await delay(30);
    }
    return response;
  }
}

class OpenAiModelClient implements ModelClient {
  constructor(private readonly apiKey: string, private readonly baseUrl?: string) {}

  async chat(request: ChatRequest, onChunk?: (chunk: string) => void): Promise<string> {
    const endpoint = `${this.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`;
    const contextBlock = formatContext(request.context);
    const systemPrompt = [
      'You are GPTStudio, a coding copilot working inside VS Code.',
      'Be concise. Return plain text.',
      'Use the provided context (files, open buffers) to ground answers.',
      `Mode: ${request.mode}`,
      request.customGpt ? `Persona: ${request.customGpt}` : undefined
    ]
      .filter(Boolean)
      .join('\n');

    const body = {
      model: request.model === 'custom-endpoint' ? 'gpt-4.1' : request.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${contextBlock}\n\nUser: ${request.prompt}` }
      ],
      stream: false,
      temperature: 0.2
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Model request failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as any;
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('Model returned no content.');
    }
    onChunk?.(text);
    return text;
  }
}

function formatContext(context: ContextBundle): string {
  const openFiles = context.openFiles
    .map((f) => `- ${f.path}${f.content ? `\n---\n${f.content}\n---` : ''}`)
    .join('\n');
  return [
    `Workspace: ${context.workspaceName}`,
    `Files (sample): ${context.files.slice(0, 10).join(', ') || 'None'}`,
    `Open files:\n${openFiles || 'None'}`
  ].join('\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
