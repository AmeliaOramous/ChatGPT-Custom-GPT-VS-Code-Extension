import * as vscode from 'vscode';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { buildContextBundle, ContextBundle } from './context';
import { createModelClient, Mode, ModelClient } from './modelClient';
import { CustomGpt, CustomGptService } from './customGptService';

const gptstudioLogger = vscode.window.createOutputChannel('GPTStudio');
gptstudioLogger.appendLine('GPTStudio module loaded.');

type GitExtension = {
  getAPI(version: number): {
    repositories: Array<{
      rootUri: vscode.Uri;
      repository: {
        log(options?: { maxEntries?: number }): Promise<Array<{ hash: string }>>;
        diff(ref?: string): Promise<string>;
      };
    }>;
  };
};

async function getGitApi(): Promise<GitExtension['getAPI'] | undefined> {
  const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExt) {
    vscode.window.showWarningMessage('Git extension not found. Install/enable Git to use GPTStudio.');
    return undefined;
  }
  if (!gitExt.isActive) {
    await gitExt.activate();
  }
  return gitExt.exports.getAPI;
}

const MAX_DIFF_PREVIEW = 200_000; // guardrail to avoid huge payloads

async function reviewLastCommit(): Promise<void> {
  const getApi = await getGitApi();
  if (!getApi) {
    return;
  }

  const api = getApi(1);
  const repo = api.repositories[0];
  if (!repo) {
    vscode.window.showInformationMessage('No Git repository detected in this workspace.');
    return;
  }

  const [lastCommit] = await repo.repository.log({ maxEntries: 1 });
  if (!lastCommit) {
    vscode.window.showInformationMessage('No commits found to review.');
    return;
  }

  const diff = await repo.repository.diff(lastCommit.hash);
  if (diff.length > MAX_DIFF_PREVIEW) {
    vscode.window.showWarningMessage(
      `Diff is large (${diff.length} chars). Consider narrowing the range before sending to a model.`
    );
  }

  const output = vscode.window.createOutputChannel('GPTStudio Review');
  output.appendLine(`# Review stub`);
  output.appendLine(`Commit: ${lastCommit.hash}`);
  output.appendLine(`Diff length: ${diff.length}`);
  output.appendLine('TODO: send diff to model and render structured feedback.');
  output.show(true);
}

async function applySuggestedPatch(): Promise<void> {
  vscode.window.showInformationMessage('Patch application pipeline not implemented yet.');
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'chat'; content: string }
  | { type: 'modelChanged'; model: string }
  | { type: 'customGptChanged'; id: string }
  | { type: 'modeChanged'; mode: Mode };

type ExtensionMessage =
  | {
      type: 'state';
      models: Array<{ id: string; label: string }>;
      selectedModel: string;
      customGpts: Array<{ id: string; label: string }>;
      selectedCustomGpt?: string;
      mode: Mode;
    }
  | { type: 'context'; files: string[]; openFiles: Array<{ path: string }> }
  | { type: 'responseStart' }
  | { type: 'responseChunk'; text: string }
  | { type: 'responseDone'; text: string }
  | { type: 'error'; message: string };

const MODEL_CHOICES: Array<{ id: string; label: string }> = [
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (fast)' },
  { id: 'gpt-4.1', label: 'GPT-4.1 (balanced)' },
  { id: 'gpt-4o', label: 'GPT-4o (vision-capable)' },
  { id: 'custom-endpoint', label: 'Custom Endpoint' }
];

class GptStudioViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'gptstudio.panel';
  private view?: vscode.WebviewView;
  private selectedModel = MODEL_CHOICES[0].id;
  private customGpts: CustomGpt[] = [];
  private selectedCustomGpt?: string;
  private mode: Mode = 'chat';
  private modelClient: ModelClient;
  private lastContext?: ContextBundle;
  private readonly customGptService: CustomGptService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.modelClient = createModelClient();
    this.customGptService = new CustomGptService({
      apiKey: process.env.OPENAI_API_KEY || process.env.GPTSTUDIO_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || process.env.GPTSTUDIO_API_BASE,
      envList: process.env.GPTSTUDIO_CUSTOM_GPTS,
      logger: gptstudioLogger
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true
    };
    webview.html = this.getHtml(webview);
    webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(message));

    // Kick off async load of custom GPTs without blocking UI
    void this.refreshCustomGpts();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postState();
        await this.postContextPreview();
        break;
      case 'modelChanged':
        this.selectedModel = message.model;
        this.postState();
        break;
      case 'customGptChanged':
        this.selectedCustomGpt = message.id;
        this.postState();
        break;
      case 'modeChanged':
        this.mode = message.mode;
        this.postState();
        break;
      case 'chat':
        await this.handleChat(message.content);
        break;
      default:
        this.view?.webview.postMessage({ type: 'error', message: 'Unknown message type' } satisfies ExtensionMessage);
    }
  }

  private async handleChat(content: string): Promise<void> {
    const context = await buildContextBundle();
    this.lastContext = context;
    this.postContextPreview(context);
    this.view?.webview.postMessage({ type: 'responseStart' } satisfies ExtensionMessage);
    gptstudioLogger.appendLine(
      `[Chat] model=${this.selectedModel} mode=${this.mode} customGpt=${this.selectedCustomGpt ?? 'none'}`
    );

    try {
      const final = await this.modelClient.chat(
        {
          model: this.selectedModel,
          mode: this.mode,
          customGpt: this.selectedCustomGpt,
          prompt: content,
          context
        },
        (chunk) => this.view?.webview.postMessage({ type: 'responseChunk', text: chunk } satisfies ExtensionMessage)
      );
      this.view?.webview.postMessage({ type: 'responseDone', text: final } satisfies ExtensionMessage);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      gptstudioLogger.appendLine(`[Chat error] ${message}`);
      this.view?.webview.postMessage({ type: 'error', message } satisfies ExtensionMessage);
    }
  }

  private async postContextPreview(context?: ContextBundle): Promise<void> {
    const ctx = context ?? (await buildContextBundle());
    this.view?.webview.postMessage(
      {
        type: 'context',
        files: ctx.files,
        openFiles: ctx.openFiles.map((f) => ({ path: f.path }))
      } satisfies ExtensionMessage
    );
  }

  private postState(): void {
    const message: ExtensionMessage = {
      type: 'state',
      models: MODEL_CHOICES,
      selectedModel: this.selectedModel,
      customGpts: this.customGpts,
      selectedCustomGpt: this.selectedCustomGpt,
      mode: this.mode
    };
    this.view?.webview.postMessage(message);
  }

  private async refreshCustomGpts(): Promise<void> {
    try {
      const list = await this.customGptService.load();
      this.customGpts = list;
      this.selectedCustomGpt = list[0]?.id;
      this.postState();
    } catch (err) {
      gptstudioLogger.appendLine(
        `[Custom GPT load] ${err instanceof Error ? err.message : 'Unknown error loading custom GPTs.'}`
      );
      this.customGpts = [];
      this.selectedCustomGpt = undefined;
      this.postState();
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: light dark;
      --panel-bg: linear-gradient(135deg, #0f172a, #111827);
      --card-bg: rgba(255, 255, 255, 0.04);
      --accent: #7dd3fc;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --border: rgba(255, 255, 255, 0.08);
    }
    body {
      margin: 0;
      padding: 12px;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      background: var(--panel-bg);
      color: var(--text);
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      background: var(--card-bg);
      backdrop-filter: blur(6px);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .eyebrow {
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      font-size: 11px;
    }
    .title {
      font-weight: 700;
      font-size: 16px;
    }
    select, button, textarea {
      width: 100%;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      padding: 8px;
      font-size: 13px;
    }
    button {
      cursor: pointer;
      background: var(--accent);
      color: #0f172a;
      font-weight: 700;
      border: none;
      transition: transform 120ms ease, box-shadow 120ms ease;
      box-shadow: 0 8px 24px rgba(125, 211, 252, 0.2);
    }
    button:active {
      transform: translateY(1px);
      box-shadow: none;
    }
    textarea {
      resize: vertical;
      min-height: 80px;
    }
    .row {
      display: flex;
      gap: 8px;
    }
    .row .pill {
      flex: 1;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.04);
      cursor: pointer;
      text-align: center;
      font-weight: 600;
      color: var(--muted);
      transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
    }
    .row .pill.active {
      border-color: var(--accent);
      color: var(--text);
      background: rgba(125, 211, 252, 0.1);
    }
    .context {
      margin-top: 10px;
      padding: 10px;
      border-radius: 8px;
      border: 1px dashed var(--border);
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      max-height: 120px;
      overflow: auto;
    }
    .log {
      margin-top: 10px;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.02);
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      white-space: pre-wrap;
      max-height: 200px;
      overflow: auto;
    }
    .section-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: var(--muted);
      margin: 12px 0 6px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div>
        <div class="eyebrow">GPTStudio</div>
        <div class="title">Workspace Copilot</div>
      </div>
      <div style="flex: 0 0 140px;">
        <select id="model"></select>
      </div>
    </div>
    <div class="section-title">Custom GPT</div>
    <select id="customGpt"></select>
    <div class="section-title">Mode</div>
    <div class="row" id="modes">
      <div class="pill active" data-mode="chat">Chat</div>
      <div class="pill" data-mode="agent">Agent (guided)</div>
      <div class="pill" data-mode="full-agent">Full Agent (guarded)</div>
    </div>
    <div class="section-title">Context preview</div>
    <div class="context" id="context">Loading workspace files...</div>
    <div class="section-title">Prompt</div>
    <textarea id="prompt" placeholder="Ask a question or give an instruction with project context."></textarea>
    <button id="send" style="margin-top: 10px;">Send to Model</button>
    <div class="section-title">Transcript</div>
    <div class="log" id="log">Ready.</div>
  </div>
    <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const modelSelect = document.getElementById('model');
    const customGptSelect = document.getElementById('customGpt');
    const promptEl = document.getElementById('prompt');
    const logEl = document.getElementById('log');
    const contextEl = document.getElementById('context');
    const modePills = document.querySelectorAll('.pill');

    function setLog(text) {
      logEl.textContent = text;
      logEl.scrollTop = logEl.scrollHeight;
    }
    function appendLog(text) {
      logEl.textContent += text;
      logEl.scrollTop = logEl.scrollHeight;
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (!msg || !msg.type) return;
      if (msg.type === 'state') {
        modelSelect.innerHTML = '';
        msg.models.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt.id;
          o.textContent = opt.label;
          if (opt.id === msg.selectedModel) o.selected = true;
          modelSelect.appendChild(o);
        });
        modePills.forEach(pill => {
          pill.classList.toggle('active', pill.dataset.mode === msg.mode);
        });
        customGptSelect.innerHTML = '';
        if (!msg.customGpts || msg.customGpts.length === 0) {
          const o = document.createElement('option');
          o.value = '';
          o.textContent = 'No custom GPTs configured';
          customGptSelect.appendChild(o);
          customGptSelect.disabled = true;
        } else {
          customGptSelect.disabled = false;
          msg.customGpts.forEach(opt => {
            const o = document.createElement('option');
            o.value = opt.id;
            o.textContent = opt.label;
            if (opt.id === msg.selectedCustomGpt) o.selected = true;
            customGptSelect.appendChild(o);
          });
        }
      } else if (msg.type === 'context') {
        const lines = [];
        lines.push('Files:', ...(msg.files && msg.files.length ? msg.files : ['No workspace files found.']));
        if (msg.openFiles && msg.openFiles.length) {
          lines.push('', 'Open files:', ...msg.openFiles.map(f => f.path));
        }
        contextEl.textContent = lines.join('\n');
      } else if (msg.type === 'responseStart') {
        setLog('Waiting for model...\n');
      } else if (msg.type === 'responseChunk') {
        appendLog(msg.text);
      } else if (msg.type === 'responseDone') {
        appendLog('\n---\nComplete.');
      } else if (msg.type === 'error') {
        setLog('Error: ' + msg.message);
      }
    });

    modelSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'modelChanged', model: modelSelect.value });
    });
    customGptSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'customGptChanged', id: customGptSelect.value });
    });

    modePills.forEach(pill => {
      pill.addEventListener('click', () => {
        modePills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        vscode.postMessage({ type: 'modeChanged', mode: pill.dataset.mode });
      });
    });

    document.getElementById('send').addEventListener('click', () => {
      const content = promptEl.value.trim();
      if (!content) {
        setLog('Enter a prompt first.');
        return;
      }
      vscode.postMessage({ type: 'chat', content });
      setLog('Sending to model...');
    });

    vscode.postMessage({ type: 'ready' });
  </script>

</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 16 }, () => possible.charAt(Math.floor(Math.random() * possible.length))).join('');
}

function loadCustomGpts(): Array<{ id: string; label: string }> {
  const raw = process.env.GPTSTUDIO_CUSTOM_GPTS;
  if (!raw) {
    return [
      { id: 'gertrude', label: 'Gertrude (review hawk)' },
      { id: 'ida', label: 'Ida (integrator)' }
    ];
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id, label: id }));
}

function loadEnv(context: vscode.ExtensionContext): void {
  try {
    const envPath = path.join(context.extensionPath, '.env');
    const result = dotenv.config({ path: envPath });
    if (result.error) {
      gptstudioLogger.appendLine(`[Env] No .env loaded or error: ${result.error.message}`);
    } else {
      gptstudioLogger.appendLine('[Env] Loaded .env file.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    gptstudioLogger.appendLine(`[Env] Failed to load .env: ${message}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  gptstudioLogger.appendLine('Activating GPTStudio extension.');
  try {
    loadEnv(context);
    const panelProvider = new GptStudioViewProvider(context);
    context.subscriptions.push(
      vscode.commands.registerCommand('gptstudio.reviewLastCommit', reviewLastCommit),
      vscode.commands.registerCommand('gptstudio.applySuggestedPatch', applySuggestedPatch),
      vscode.window.registerWebviewViewProvider(GptStudioViewProvider.viewId, panelProvider)
    );
    gptstudioLogger.appendLine('GPTStudio extension activated.');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    gptstudioLogger.appendLine(`[Activation error] ${message}`);
    void vscode.window.showErrorMessage(`GPTStudio failed to activate: ${message}`);
    throw err;
  }
}

export function deactivate(): void {
  // noop
}
