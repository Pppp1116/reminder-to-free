const vscode = require("vscode");

let isApplyingEdit = false;

function activate(context) {
  const refreshCommand = vscode.commands.registerCommand(
    "cCleanupScaffold.refreshDocument",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await processDocument(editor.document, true);
    }
  );

  const disposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (isApplyingEdit) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (editor.document !== event.document) return;

    await processDocument(event.document, false, event.contentChanges);
  });

  context.subscriptions.push(refreshCommand, disposable);
}

async function processDocument(doc, fullRefresh, changes = []) {
  if (!isSupportedDocument(doc)) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== doc) return;

  const config = getConfig();
  if (!config.enabled) return;

  const analysis = analyzeDocument(doc, config);
  const edits = [];

  if (config.detectOwnedReturnFunctions) {
    for (const fn of analysis.functions) {
      if (!fn.returnsOwnedAllocation) continue;

      for (const alloc of fn.allocations) {
        const scaffold = findScaffoldCleanupBelow(doc, alloc.line, alloc.varName, config.cleanupFunctionName, fn.endLine);
        if (scaffold) {
          edits.push({
            kind: "delete",
            range: scaffold.range
          });
        }
      }
    }
  }

  const targetLines = fullRefresh
    ? [...Array(doc.lineCount).keys()]
    : collectTouchedLines(changes, doc.lineCount);

  for (const lineNumber of targetLines) {
    const line = doc.lineAt(lineNumber);
    const text = line.text;

    const directAlloc = parseDirectAllocationLine(text, config.allocatorFunctions);
    if (directAlloc) {
      const ownerFn = findContainingFunction(analysis.functions, lineNumber);
      if (ownerFn && ownerFn.returnsOwnedAllocation && ownerFn.ownedVars.has(directAlloc.varName)) {
        continue;
      }

      const existing = findScaffoldCleanupBelow(
        doc,
        lineNumber,
        directAlloc.varName,
        config.cleanupFunctionName,
        ownerFn ? ownerFn.endLine : doc.lineCount - 1
      );

      if (!existing) {
        edits.push(makeInsertEdit(lineNumber, directAlloc.indent, directAlloc.varName, config.cleanupFunctionName));
      }

      continue;
    }

    if (config.detectOwnedReturnFunctions) {
      const callAlloc = parseOwnedFactoryCallAssignment(text, analysis.ownedFunctionNames);
      if (callAlloc) {
        const ownerFn = findContainingFunction(analysis.functions, lineNumber);
        const existing = findScaffoldCleanupBelow(
          doc,
          lineNumber,
          callAlloc.varName,
          config.cleanupFunctionName,
          ownerFn ? ownerFn.endLine : doc.lineCount - 1
        );

        if (!existing) {
          edits.push(makeInsertEdit(lineNumber, callAlloc.indent, callAlloc.varName, config.cleanupFunctionName));
        }
      }
    }
  }

  const finalEdits = dedupeEdits(edits);
  if (!finalEdits.length) return;

  const oldSelections = editor.selections.map(
    (s) => new vscode.Selection(s.start, s.end)
  );

  isApplyingEdit = true;
  try {
    await editor.edit((editBuilder) => {
      for (const edit of sortEditsDescending(finalEdits)) {
        if (edit.kind === "delete") {
          editBuilder.delete(edit.range);
        } else if (edit.kind === "insert") {
          editBuilder.insert(edit.position, edit.text);
        }
      }
    });
    editor.selections = oldSelections;
  } finally {
    isApplyingEdit = false;
  }
}

function isSupportedDocument(doc) {
  return doc && (doc.languageId === "c" || doc.languageId === "cpp");
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("cCleanupScaffold");
  const allocatorFunctions = cfg.get("allocatorFunctions", [
    "malloc",
    "calloc",
    "realloc",
    "strdup",
    "strndup"
  ]);

  return {
    enabled: cfg.get("enabled", true),
    detectOwnedReturnFunctions: cfg.get("detectOwnedReturnFunctions", true),
    allocatorFunctions: allocatorFunctions.filter(Boolean),
    cleanupFunctionName: cfg.get("cleanupFunctionName", "free")
  };
}

function analyzeDocument(doc, config) {
  const lines = [];
  for (let i = 0; i < doc.lineCount; i++) {
    lines.push(doc.lineAt(i).text);
  }

  const functions = findFunctions(lines, config.allocatorFunctions);
  const ownedFunctionNames = new Set(
    functions.filter((fn) => fn.returnsOwnedAllocation).map((fn) => fn.name)
  );

  return { functions, ownedFunctionNames };
}

function findFunctions(lines, allocatorFunctions) {
  const functions = [];
  const allocatorRegex = buildAllocatorRegex(allocatorFunctions);

  let pending = null;
  let braceDepth = 0;
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const text = stripLineComment(raw);
    const trimmed = text.trim();

    if (!current) {
      if (!pending) {
        const maybeName = extractFunctionNameFromHeaderLine(trimmed);
        if (maybeName) {
          pending = { name: maybeName, startLine: i };
        }
      } else {
        if (!trimmed || trimmed.startsWith("//")) {
        } else if (trimmed.includes("{")) {
          current = {
            name: pending.name,
            startLine: pending.startLine,
            headerEndLine: i,
            bodyStartLine: i,
            endLine: i,
            allocations: [],
            returnsOwnedAllocation: false,
            ownedVars: new Set()
          };
          braceDepth = countChar(text, "{") - countChar(text, "}");
          pending = null;

          if (braceDepth === 0) {
            current.endLine = i;
            finalizeFunction(current, lines, allocatorRegex);
            functions.push(current);
            current = null;
          }
          continue;
        } else if (trimmed.endsWith(";")) {
          pending = null;
        }
      }
    }

    if (current) {
      if (i > current.bodyStartLine) {
        braceDepth += countChar(text, "{");
        braceDepth -= countChar(text, "}");
      }

      if (braceDepth <= 0) {
        current.endLine = i;
        finalizeFunction(current, lines, allocatorRegex);
        functions.push(current);
        current = null;
        pending = null;
      }
    }
  }

  return functions;
}

function finalizeFunction(fn, lines, allocatorRegex) {
  for (let i = fn.bodyStartLine; i <= fn.endLine; i++) {
    const text = stripLineComment(lines[i]);
    const alloc = parseDirectAllocationLine(text, allocatorRegex, true);
    if (alloc) {
      alloc.line = i;
      fn.allocations.push(alloc);
      fn.ownedVars.add(alloc.varName);
    }
  }

  for (let i = fn.bodyStartLine; i <= fn.endLine; i++) {
    const text = stripLineComment(lines[i]);
    const m = text.match(/^\s*return\s+([A-Za-z_]\w*)\s*;/);
    if (m && fn.ownedVars.has(m[1])) {
      fn.returnsOwnedAllocation = true;
      break;
    }
  }
}

function parseDirectAllocationLine(text, allocatorFunctionsOrRegex, regexAlreadyBuilt = false) {
  const allocatorRegex = regexAlreadyBuilt
    ? allocatorFunctionsOrRegex
    : buildAllocatorRegex(allocatorFunctionsOrRegex);

  const trimmed = stripLineComment(text).trim();
  if (!trimmed.endsWith(";")) return null;
  if (!allocatorRegex.test(trimmed)) return null;

  const namesSource = allocatorRegex.source
    .replace(/^\\b\(\?:/, "")
    .replace(/\\s\*\\\($/, "");

  const typedPattern = new RegExp(
    String.raw`^(?:[A-Za-z_]\w*(?:\s+|\s*\*+\s*))+?([A-Za-z_]\w*)\s*=\s*(?:\([^)]*\)\s*)?(?:${namesSource})\s*\(`
  );
  const plainPattern = new RegExp(
    String.raw`^([A-Za-z_]\w*)\s*=\s*(?:\([^)]*\)\s*)?(?:${namesSource})\s*\(`
  );

  const match = trimmed.match(typedPattern) || trimmed.match(plainPattern);
  if (!match) return null;

  return {
    varName: match[1],
    indent: text.match(/^\s*/)?.[0] ?? ""
  };
}

function parseOwnedFactoryCallAssignment(text, ownedFunctionNames) {
  if (!ownedFunctionNames || !ownedFunctionNames.size) return null;

  const trimmed = stripLineComment(text).trim();
  if (!trimmed.endsWith(";")) return null;

  const names = [...ownedFunctionNames].map(escapeRegex).join("|");
  const typedPattern = new RegExp(
    String.raw`^(?:[A-Za-z_]\w*(?:\s+|\s*\*+\s*))+?([A-Za-z_]\w*)\s*=\s*(${names})\s*\(`
  );
  const plainPattern = new RegExp(
    String.raw`^([A-Za-z_]\w*)\s*=\s*(${names})\s*\(`
  );

  const match = trimmed.match(typedPattern) || trimmed.match(plainPattern);
  if (!match) return null;

  return {
    varName: match[1],
    callee: match[2],
    indent: text.match(/^\s*/)?.[0] ?? ""
  };
}

function findScaffoldCleanupBelow(doc, startLine, varName, cleanupFunctionName, maxLine) {
  const pattern = new RegExp(`^\\s*${escapeRegex(cleanupFunctionName)}\\s*\\(\\s*${escapeRegex(varName)}\\s*\\)\\s*;\\s*$`);

  for (let i = startLine + 1; i <= maxLine && i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    const trimmed = text.trim();

    if (!trimmed) continue;
    if (pattern.test(text)) {
      const start = new vscode.Position(i, 0);
      const end = i + 1 < doc.lineCount
        ? new vscode.Position(i + 1, 0)
        : new vscode.Position(i, text.length);
      return {
        line: i,
        range: new vscode.Range(start, end)
      };
    }
  }

  return null;
}

function makeInsertEdit(lineNumber, indent, varName, cleanupFunctionName) {
  return {
    kind: "insert",
    position: new vscode.Position(lineNumber + 1, 0),
    text: `${indent}${cleanupFunctionName}(${varName});\n`
  };
}

function collectTouchedLines(changes, lineCount) {
  const set = new Set();

  for (const change of changes) {
    const start = Math.max(0, change.range.start.line - 2);
    const end = Math.min(lineCount - 1, change.range.end.line + 2);
    for (let i = start; i <= end; i++) {
      set.add(i);
    }
  }

  return [...set].sort((a, b) => a - b);
}

function findContainingFunction(functions, lineNumber) {
  return functions.find((fn) => lineNumber >= fn.startLine && lineNumber <= fn.endLine) || null;
}

function extractFunctionNameFromHeaderLine(trimmed) {
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) return null;
  if (/^(if|for|while|switch|return|sizeof)\b/.test(trimmed)) return null;
  if (!trimmed.includes("(") || !trimmed.includes(")")) return null;

  const match = trimmed.match(/([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|$)/);
  if (!match) return null;

  const name = match[1];
  if (["if", "for", "while", "switch"].includes(name)) return null;
  return name;
}

function buildAllocatorRegex(allocatorFunctions) {
  const names = allocatorFunctions.map(escapeRegex).join("|");
  return new RegExp(`\\b(?:${names})\\s*\\(`);
}

function stripLineComment(text) {
  return text.replace(/\/\/.*$/, "");
}

function countChar(text, ch) {
  let count = 0;
  for (const c of text) {
    if (c === ch) count++;
  }
  return count;
}

function dedupeEdits(edits) {
  const seen = new Set();
  const result = [];

  for (const edit of edits) {
    const key = edit.kind === "delete"
      ? `d:${edit.range.start.line}:${edit.range.start.character}:${edit.range.end.line}:${edit.range.end.character}`
      : `i:${edit.position.line}:${edit.position.character}:${edit.text}`;

    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edit);
  }

  return result;
}

function sortEditsDescending(edits) {
  return edits.slice().sort((a, b) => {
    const aLine = a.kind === "delete" ? a.range.start.line : a.position.line;
    const bLine = b.kind === "delete" ? b.range.start.line : b.position.line;
    if (aLine !== bLine) return bLine - aLine;

    const aChar = a.kind === "delete" ? a.range.start.character : a.position.character;
    const bChar = b.kind === "delete" ? b.range.start.character : b.position.character;
    return bChar - aChar;
  });
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
