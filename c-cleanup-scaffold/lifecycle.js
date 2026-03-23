const core = require("./core");

function deriveManualOptOuts(previousLines, currentLines, existingOptOuts, functions = {}) {
  const collectKeys = functions.collectCleanupKeys || collectCleanupKeys;
  const currentManaged = collectKeys(currentLines, true);
  const currentUnmanaged = collectKeys(currentLines, false);
  const previousManaged = collectKeys(previousLines, true);
  const nextOptOuts = new Set();

  for (const key of existingOptOuts) {
    if (currentUnmanaged.has(key)) {
      nextOptOuts.add(key);
    }
  }

  for (const key of previousManaged) {
    if (currentManaged.has(key)) continue;
    if (currentUnmanaged.has(key)) {
      nextOptOuts.add(key);
    }
  }

  return nextOptOuts;
}

function detectManualOwnershipLineNumbers(previousLines, currentLines, touchedCurrentLines) {
  if (!touchedCurrentLines.length || !currentLines.length) return [];

  const manualLineNumbers = [];

  for (const lineNumber of touchedCurrentLines) {
    const currentScaffold = core.parseManagedScaffoldLine(currentLines[lineNumber] ?? "");
    if (!currentScaffold) continue;

    const previousScaffold = core.parseManagedScaffoldLine(previousLines[lineNumber] ?? "");
    if (
      previousScaffold
      && previousScaffold.varName === currentScaffold.varName
      && previousScaffold.cleanupFunction === currentScaffold.cleanupFunction
      && (previousLines[lineNumber] ?? "") === (currentLines[lineNumber] ?? "")
    ) {
      continue;
    }

    if (findMovedManagedScaffoldOrigin(previousLines, currentLines, lineNumber) >= 0) {
      continue;
    }

    manualLineNumbers.push(lineNumber);
  }

  return manualLineNumbers;
}

function collectCleanupKeys(lines, markerPresent) {
  if (!lines.length) return new Set();

  const sanitizedLines = core.sanitizeLines(lines);
  const functions = core.findFunctions(lines, sanitizedLines);
  const creations = core.collectSourceCreations(lines);
  const blockHints = core.collectBlockHints(lines);
  const keys = new Set();

  for (let i = 0; i < lines.length; i++) {
    const cleanup = core.parseCleanupCallLine(lines[i]);
    if (!cleanup) continue;
    if (cleanup.markerPresent !== markerPresent) continue;

    const fn = findContainingFunction(functions, i);
    if (!fn) continue;

    const creationKey = findUniqueCreationKeyForCleanup(
      creations,
      fn,
      cleanup,
      blockHints.get(i) || "root"
    );
    keys.add(creationKey || core.buildManagedOwnershipKey(fn.name, cleanup.varName, cleanup.cleanupFunction));
  }

  return keys;
}

function findUniqueCreationKeyForCleanup(creations, fn, cleanup, blockKey) {
  const candidates = creations.filter(
    (creation) => creation.functionStartLine === fn.startLine
      && creation.cleanupFunction === cleanup.cleanupFunction
      && creation.varName === cleanup.varName
      && creation.blockKey === blockKey
  );

  return candidates.length === 1 ? candidates[0].creationKey : null;
}

function findMovedManagedScaffoldOrigin(previousLines, currentLines, currentLineNumber) {
  const scaffoldText = currentLines[currentLineNumber] ?? "";
  const scaffold = core.parseManagedScaffoldLine(scaffoldText);
  if (!scaffold) return -1;

  const sanitizedPrevious = core.sanitizeLines(previousLines);
  const previousFunctions = core.findFunctions(previousLines, sanitizedPrevious);
  const sanitizedCurrent = core.sanitizeLines(currentLines);
  const currentFunctions = core.findFunctions(currentLines, sanitizedCurrent);
  const currentFunction = findContainingFunction(currentFunctions, currentLineNumber);
  if (!currentFunction) return -1;

  for (let lineNumber = 0; lineNumber < previousLines.length; lineNumber++) {
    if (lineNumber === currentLineNumber) continue;
    if (previousLines[lineNumber] !== scaffoldText) continue;

    const previousFunction = findContainingFunction(previousFunctions, lineNumber);
    if (!previousFunction || previousFunction.name !== currentFunction.name) continue;
    if (lineNumber < previousLines.length && currentLines[lineNumber] === previousLines[lineNumber]) continue;

    return lineNumber;
  }

  return -1;
}

function findContainingFunction(functions, lineNumber) {
  return functions.find((fn) => lineNumber >= fn.startLine && lineNumber <= fn.endLine) || null;
}

module.exports = {
  collectCleanupKeys,
  deriveManualOptOuts,
  detectManualOwnershipLineNumbers,
  findMovedManagedScaffoldOrigin
};
