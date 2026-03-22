const vscode = require("vscode");
const core = require("./core");

let isApplyingEdit = false;
let scaffoldDecorationType = null;

function activate(context) {
  scaffoldDecorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    opacity: "0.75",
    color: new vscode.ThemeColor("editorCodeLens.foreground")
  });

  const subscriptions = [
    vscode.commands.registerCommand(
      "cCleanupScaffold.refreshDocument",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        await processDocument(editor.document, { kind: "document" });
      }
    ),
    vscode.commands.registerCommand(
      "cCleanupScaffold.scaffoldCurrentLine",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        await processDocument(editor.document, {
          kind: "line",
          lineNumber: editor.selection.active.line
        });
      }
    ),
    vscode.commands.registerCommand(
      "cCleanupScaffold.scaffoldCurrentFunction",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        await processDocument(editor.document, {
          kind: "function",
          lineNumber: editor.selection.active.line
        });
      }
    ),
    vscode.commands.registerCommand(
      "cCleanupScaffold.finalizeScaffold",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isSupportedDocument(editor.document)) return;

        const lines = getDocumentLines(editor.document);
        const edits = core.planFinalizeEdits(lines, getFinalizeScope(editor));
        await applyPlannedEdits(editor, edits);
      }
    ),
    vscode.commands.registerCommand(
      "cCleanupScaffold.removeScaffoldMarkers",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isSupportedDocument(editor.document)) return;

        const lines = getDocumentLines(editor.document);
        const edits = core.planFinalizeEdits(lines, { kind: "document" });
        await applyPlannedEdits(editor, edits);
      }
    ),
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (isApplyingEdit) return;

      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (editor.document !== event.document) return;

      await processDocument(event.document, {
        kind: "lines",
        lineNumbers: collectTouchedLines(event.contentChanges, event.document.lineCount)
      });
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      refreshDecorations(editor);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === document) {
        refreshDecorations(editor);
      }
    })
  ];

  context.subscriptions.push(scaffoldDecorationType, ...subscriptions);
  refreshDecorations(vscode.window.activeTextEditor);
}

async function processDocument(document, scope) {
  if (!isSupportedDocument(document)) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== document) return;

  const config = getConfig();
  if (!config.enabled) {
    refreshDecorations(editor);
    return;
  }

  const lines = getDocumentLines(document);
  const plan = core.planScaffoldEdits(lines, config, scope);
  await applyPlannedEdits(editor, plan.edits);
}

async function applyPlannedEdits(editor, edits) {
  if (!edits.length) {
    refreshDecorations(editor);
    return;
  }

  const translatedSelections = translateSelections(editor, edits);

  isApplyingEdit = true;
  try {
    await editor.edit((editBuilder) => {
      for (const edit of sortEditsDescending(edits)) {
        if (edit.kind === "insert") {
          editBuilder.insert(
            new vscode.Position(edit.afterLine + 1, 0),
            `${edit.text}\n`
          );
          continue;
        }

        if (edit.kind === "deleteLine") {
          editBuilder.delete(getLineDeleteRange(editor.document, edit.lineNumber));
          continue;
        }

        if (edit.kind === "replaceLine") {
          editBuilder.replace(editor.document.lineAt(edit.lineNumber).range, edit.text);
        }
      }
    });

    editor.selections = translatedSelections;
  } finally {
    isApplyingEdit = false;
    refreshDecorations(editor);
  }
}

function refreshDecorations(editor) {
  if (!scaffoldDecorationType) return;
  if (!editor || !isSupportedDocument(editor.document)) {
    if (editor) {
      editor.setDecorations(scaffoldDecorationType, []);
    }
    return;
  }

  const lines = getDocumentLines(editor.document);
  const options = core.collectManagedScaffoldLines(lines).map((scaffold) => ({
    range: editor.document.lineAt(scaffold.line).range,
    hoverMessage: "Auto-inserted cleanup scaffold. Keep typing above it, move it when you want, or finalize it to make it yours."
  }));

  editor.setDecorations(scaffoldDecorationType, options);
}

function getConfig() {
  const config = vscode.workspace.getConfiguration("cCleanupScaffold");

  return {
    enabled: config.get("enabled", true),
    detectOwnedReturnFunctions: config.get("detectOwnedReturnFunctions", true),
    allocatorFunctions: config.get("allocatorFunctions", [
      "malloc",
      "calloc",
      "realloc",
      "strdup",
      "strndup"
    ]),
    cleanupFunctionName: config.get("cleanupFunctionName", "free"),
    cleanupMap: config.get("cleanupMap", {
      malloc: "free",
      calloc: "free",
      realloc: "free",
      strdup: "free",
      strndup: "free"
    }),
    ownedReturnFunctions: config.get("ownedReturnFunctions", [])
  };
}

function isSupportedDocument(document) {
  return document && (document.languageId === "c" || document.languageId === "cpp");
}

function getDocumentLines(document) {
  const lines = [];

  for (let i = 0; i < document.lineCount; i++) {
    lines.push(document.lineAt(i).text);
  }

  return lines;
}

function collectTouchedLines(changes, lineCount) {
  const lineNumbers = new Set();

  for (const change of changes) {
    const insertedLineCount = change.text.split("\n").length - 1;
    const start = Math.max(0, change.range.start.line - 1);
    const end = Math.min(
      lineCount - 1,
      Math.max(change.range.end.line, change.range.start.line + insertedLineCount) + 1
    );

    for (let i = start; i <= end; i++) {
      lineNumbers.add(i);
    }
  }

  return [...lineNumbers].sort((a, b) => a - b);
}

function getFinalizeScope(editor) {
  const selection = editor.selection;

  if (!selection.isEmpty) {
    const lineNumbers = [];
    for (let i = selection.start.line; i <= selection.end.line; i++) {
      lineNumbers.push(i);
    }

    return {
      kind: "lines",
      lineNumbers
    };
  }

  return {
    kind: "function",
    lineNumber: selection.active.line
  };
}

function getLineDeleteRange(document, lineNumber) {
  return document.lineAt(lineNumber).rangeIncludingLineBreak;
}

function translateSelections(editor, edits) {
  return editor.selections.map((selection) => {
    const start = translatePosition(editor.document, selection.start, edits);
    const end = translatePosition(editor.document, selection.end, edits);
    return new vscode.Selection(start, end);
  });
}

function translatePosition(document, position, edits) {
  let line = position.line;

  for (const edit of edits) {
    if (edit.kind === "insert") {
      if (edit.afterLine < line) {
        line += countInsertedLines(edit.text);
      }
      continue;
    }

    if (edit.kind === "deleteLine" && edit.lineNumber < line) {
      line -= 1;
      continue;
    }

    if (edit.kind === "deleteLine" && edit.lineNumber === line) {
      line = Math.max(0, line - 1);
    }
  }

  const safeLine = Math.min(Math.max(0, line), document.lineCount - 1);
  const maxCharacter = document.lineCount
    ? document.lineAt(safeLine).text.length
    : position.character;
  return new vscode.Position(Math.max(0, line), Math.min(position.character, maxCharacter));
}

function countInsertedLines(text) {
  return text.split("\n").length - 1 || 1;
}

function sortEditsDescending(edits) {
  return edits.slice().sort((a, b) => {
    const aLine = editLineNumber(a);
    const bLine = editLineNumber(b);
    if (aLine !== bLine) return bLine - aLine;

    const order = { deleteLine: 0, replaceLine: 1, insert: 2 };
    return order[a.kind] - order[b.kind];
  });
}

function editLineNumber(edit) {
  if (edit.kind === "insert") return edit.afterLine + 1;
  return edit.lineNumber;
}

function deactivate() {
  if (scaffoldDecorationType) {
    scaffoldDecorationType.dispose();
    scaffoldDecorationType = null;
  }
}

module.exports = {
  activate,
  deactivate
};
