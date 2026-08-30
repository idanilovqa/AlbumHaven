const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function assertMediaRoots(sourceMediaRoot, writableMediaRoot) {
  const sourceRoot = path.resolve(String(sourceMediaRoot || '').trim());
  const writableRoot = path.resolve(String(writableMediaRoot || '').trim());
  if (sourceRoot === writableRoot) {
    throw new Error('functional source and writable media roots must be distinct');
  }
  if (path.basename(sourceRoot).toLowerCase() !== 'media'
    || path.basename(writableRoot).toLowerCase() !== 'media'
    || path.basename(path.dirname(writableRoot)).toLowerCase() !== 'shared') {
    throw new Error('functional checkpoint paths must be source and shared writable media roots');
  }
  const sourceToWritable = path.relative(sourceRoot, writableRoot);
  const writableToSource = path.relative(writableRoot, sourceRoot);
  if ((!sourceToWritable.startsWith('..') && !path.isAbsolute(sourceToWritable))
    || (!writableToSource.startsWith('..') && !path.isAbsolute(writableToSource))) {
    throw new Error('functional source and writable media roots must not overlap');
  }
  for (const [label, root] of [['source', sourceRoot], ['writable', writableRoot]]) {
    const stats = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`functional ${label} media root must be a normal directory`);
    }
  }
  return { sourceRoot, writableRoot };
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function inventoryTree(root) {
  const files = new Map();
  const directories = [];
  const canonicalPaths = new Set();
  const visit = (directory, relativeDirectory = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const canonical = relativePath.toLowerCase();
      if (canonicalPaths.has(canonical)) {
        throw new Error(`functional media contains a canonical path collision: ${relativePath}`);
      }
      canonicalPaths.add(canonical);
      const absolutePath = path.join(directory, entry.name);
      const stats = fs.lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`functional media links are forbidden: ${relativePath}`);
      }
      if (stats.isDirectory()) {
        directories.push(relativePath);
        visit(absolutePath, relativePath);
      } else if (stats.isFile()) {
        files.set(relativePath, {
          absolutePath,
          size: stats.size,
          sha256: sha256(absolutePath),
        });
      } else {
        throw new Error(`functional media entry type is forbidden: ${relativePath}`);
      }
    }
  };
  visit(root);
  return { files, directories };
}

function containedPath(root, relativePath) {
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`functional media path escapes its root: ${relativePath}`);
  }
  return resolved;
}

function pruneEmptyDirectories(root, directories) {
  for (const relativePath of [...directories].sort((left, right) => right.length - left.length)) {
    const directory = containedPath(root, relativePath);
    if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
    }
  }
}

function verifyMediaTree(sourceMediaRoot, writableMediaRoot) {
  const { sourceRoot, writableRoot } = assertMediaRoots(sourceMediaRoot, writableMediaRoot);
  const source = inventoryTree(sourceRoot);
  const writable = inventoryTree(writableRoot);
  if (source.files.size !== writable.files.size) {
    throw new Error('functional writable media differs from the source file count');
  }
  for (const [relativePath, sourceFile] of source.files) {
    const writableFile = writable.files.get(relativePath);
    if (!writableFile
      || writableFile.size !== sourceFile.size
      || writableFile.sha256 !== sourceFile.sha256) {
      throw new Error(`functional writable media differs: ${relativePath}`);
    }
  }
  return { files: source.files.size };
}

function restoreMediaTree({ sourceMediaRoot, writableMediaRoot }) {
  const { sourceRoot, writableRoot } = assertMediaRoots(sourceMediaRoot, writableMediaRoot);
  const source = inventoryTree(sourceRoot);
  const writable = inventoryTree(writableRoot);
  let restored = 0;
  let removed = 0;
  let unchanged = 0;

  for (const [relativePath, writableFile] of writable.files) {
    if (!source.files.has(relativePath)) {
      fs.chmodSync(writableFile.absolutePath, 0o666);
      fs.rmSync(writableFile.absolutePath);
      removed += 1;
    }
  }
  for (const [relativePath, sourceFile] of source.files) {
    const writableFile = writable.files.get(relativePath);
    if (writableFile
      && writableFile.size === sourceFile.size
      && writableFile.sha256 === sourceFile.sha256) {
      unchanged += 1;
      continue;
    }
    const destination = containedPath(writableRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination)) fs.chmodSync(destination, 0o666);
    fs.copyFileSync(sourceFile.absolutePath, destination);
    restored += 1;
  }
  pruneEmptyDirectories(writableRoot, writable.directories);
  verifyMediaTree(sourceRoot, writableRoot);
  return { restored, removed, unchanged };
}

function argumentValue(argv, name) {
  const prefix = `${name}=`;
  return argv.find((argument) => String(argument).startsWith(prefix))?.slice(prefix.length) || '';
}

function main(argv = process.argv.slice(2)) {
  const mode = argumentValue(argv, '--mode');
  const sourceMediaRoot = argumentValue(argv, '--source-media-root');
  const writableMediaRoot = argumentValue(argv, '--writable-media-root');
  if (mode === 'restore') {
    process.stdout.write(`${JSON.stringify(restoreMediaTree({ sourceMediaRoot, writableMediaRoot }))}\n`);
    return 0;
  }
  if (mode === 'verify') {
    process.stdout.write(`${JSON.stringify(verifyMediaTree(sourceMediaRoot, writableMediaRoot))}\n`);
    return 0;
  }
  throw new Error('functional media restore mode must be restore or verify');
}

module.exports = {
  inventoryTree,
  restoreMediaTree,
  verifyMediaTree,
};

if (require.main === module) {
  process.exitCode = main();
}
