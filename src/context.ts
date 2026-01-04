import * as vscode from 'vscode';

export type ContextFile = { path: string; content?: string };

export type ContextBundle = {
  workspaceName: string;
  files: string[];
  openFiles: ContextFile[];
};

const DEFAULT_EXCLUDES = '{node_modules,.git,.vscode,out,dist,build,coverage}/**';
const MAX_FILES = 20;
const MAX_OPEN_FILE_BYTES = 10_000;

export async function buildContextBundle(): Promise<ContextBundle> {
  const workspaceName = vscode.workspace.name ?? 'workspace';

  const uris = await vscode.workspace.findFiles('**/*', `**/${DEFAULT_EXCLUDES}`, MAX_FILES);
  const files = uris.map((uri) => vscode.workspace.asRelativePath(uri, false));

  const openFiles = vscode.window.visibleTextEditors
    .filter((editor) => editor.document.uri.scheme === 'file')
    .slice(0, 5)
    .map((editor) => {
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
      const text = editor.document.getText();
      const content = text.slice(0, MAX_OPEN_FILE_BYTES);
      return { path: rel, content };
    });

  return {
    workspaceName,
    files,
    openFiles
  };
}
