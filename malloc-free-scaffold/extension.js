const vscode = require("vscode");

let isApplyingEdit = false;

function activate(context) {
  const disposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (isApplyingEdit) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (editor.document !== event.document) return;

    const doc = event.document;
    const lang = doc.languageId;
    if (lang !== "c" && lang !== "cpp") return;

    for (const change of event.contentChanges) {
      const lineNumber = change.range.end.line;
      if (lineNumber < 0 || lineNumber >= doc.lineCount) continue;

      const line = doc.lineAt(lineNumber);
      const text = line.text;

      if (!text.trim().endsWith(";") || !/\bmalloc\s*\(/.test(text)) continue;

      const varMatch = text.match(/([A-Za-z_]\w*)\s*=\s*(?:\([^)]*\)\s*)?malloc\s*\(/);
      if (!varMatch) continue;

      const varName = varMatch[1];
      const indent = text.match(/^\s*/)?.[0] ?? "";
      const freeLine = `${indent}free(${varName});`;

      const insertPos = new vscode.Position(lineNumber + 1, 0);
      const oldSelections = editor.selections.map(
        (s) => new vscode.Selection(s.start, s.end)
      );

      isApplyingEdit = true;
      try {
        await editor.edit((editBuilder) => {
          editBuilder.insert(insertPos, freeLine + "\n");
        });
        editor.selections = oldSelections;
      } finally {
        isApplyingEdit = false;
      }
    }
  });

  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
