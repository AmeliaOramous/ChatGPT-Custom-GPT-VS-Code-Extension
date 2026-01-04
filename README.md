## GPTStudio (VS Code Extension)

Gertrude-style commit review helper for VS Code. Current build is a scaffold with safe placeholders.

### Prerequisites
- Node.js + npm (install from https://nodejs.org). This repo also carries a local Windows Node binary at `.tools/node-v24.12.0-win-x64` if you need a self-contained toolchain; you can prepend it to PATH via:
  ```powershell
  $env:PATH = "$PWD\\.tools\\node-v24.12.0-win-x64;" + $env:PATH
  ```
- VS Code 1.85+.

### Setup
```bash
npm install
npm run compile
```

### Commands
- `GPTStudio: Review Last Commit` (`gptstudio.reviewLastCommit`): activates Git API, grabs the most recent commit, fetches its diff, and prints stub output to the "GPTStudio Review" channel. Warns if the diff is very large before you ship it to a model.
- `GPTStudio: Apply Suggested Patch` (`gptstudio.applySuggestedPatch`): placeholder for a guarded apply flow.
- GPTStudio Panel (`gptstudio.panel` view in Explorer): opens a sidebar webview to select a model, choose a mode (Chat, Agent, Full Agent), see a preview of workspace files included as context (file list + open buffers), and send prompts. Streams responses; falls back to a mock client if no API key is set.

### Dev Notes
- Code lives in `src/extension.ts`; compiled output goes to `dist/`.
- Launch configs in `.vscode/launch.json` and tasks in `.vscode/tasks.json` support "Run Extension" with prelaunch TypeScript compile.
- Model client selection:
  - Set `OPENAI_API_KEY` (or `GPTSTUDIO_API_KEY`) to use OpenAI models; optionally set `OPENAI_BASE_URL` (`GPTSTUDIO_API_BASE`) for a custom endpoint.
  - Without an API key, a mock client echoes prompts and context so the panel is demo-ready.
- Next steps: plug panel output into the commit review flow, add patch application with an explicit approval dialog and safe-file allowlist, and persist conversations per workspace.
