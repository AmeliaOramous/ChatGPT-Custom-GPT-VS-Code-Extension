import * as vscode from 'vscode';

export type CustomGpt = { id: string; label: string };

export type CustomGptServiceOptions = {
  apiKey?: string;
  baseUrl?: string;
  envList?: string;
  logger?: vscode.OutputChannel;
};

type GptApiItem = { id: string; name?: string; display_name?: string };

export class CustomGptService {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly envList?: string;
  private readonly logger?: vscode.OutputChannel;

  constructor(options: CustomGptServiceOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.envList = options.envList;
    this.logger = options.logger;
  }

  async load(): Promise<CustomGpt[]> {
    // Try API first when key is present
    if (this.apiKey) {
      try {
        const fromApi = await this.fetchFromApi();
        if (fromApi.length) {
          this.log(`Loaded ${fromApi.length} custom GPT(s) from API.`);
          return fromApi;
        }
      } catch (err) {
        this.log(`Custom GPT API load failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Fallback to env
    const fallback = this.loadFromEnv();
    if (fallback.length) {
      this.log(`Loaded ${fallback.length} custom GPT(s) from environment fallback.`);
      return fallback;
    }

    // Default demo personas
    const defaults: CustomGpt[] = [
      { id: 'gertrude', label: 'Gertrude (review hawk)' },
      { id: 'ida', label: 'Ida (integrator)' }
    ];
    this.log('Using default demo custom GPTs.');
    return defaults;
  }

  private async fetchFromApi(): Promise<CustomGpt[]> {
    const res = await fetch(`${this.baseUrl}/gpts`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const body = (await res.json()) as { data?: GptApiItem[] };
    if (!body?.data) {
      return [];
    }

    return body.data
      .map((item) => ({
        id: item.id,
        label: item.display_name ?? item.name ?? item.id
      }))
      .filter((item) => !!item.id);
  }

  private loadFromEnv(): CustomGpt[] {
    const raw = this.envList;
    if (!raw) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => ({ id, label: id }));
  }

  private log(message: string): void {
    this.logger?.appendLine(`[CustomGptService] ${message}`);
  }
}
