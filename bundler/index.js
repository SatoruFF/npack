import esbuild from "esbuild";
import { existsSync, readFileSync  } from "fs";
import { readFile, mkdir, readdir, stat } from 'fs/promises';
import * as path from "path";
import { fileURLToPath } from "url";

async function scanMigrationsToRoot(srcMigrationsDir, assets) {
  const entries = await readdir(srcMigrationsDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(srcMigrationsDir, entry.name);

    if (entry.isDirectory()) {
      await scanMigrationsToRoot(fullPath, assets);
    } else {
      const content = await readFile(fullPath);
      const relativePath = path.relative(srcMigrationsDir, fullPath);

      assets.set("/migrations/" + relativePath.replace(/\\/g, "/"), {
        content: content.toString("base64"),
        encoding: "base64",
      });
    }
  }
}

/**
 * Собирает все статические ассеты
 */
async function collectAllAssets(appDir) {
  const assets = new Map();

  const commonDirs = [
    "config",
    "templates",
    "public",
    "assets",
    "data",
    "migrations",
    "views",
    "locale",
    "locales",
    "i18n",
    "static",
    "resources",
    "sql",
    "queries",
  ];

  for (const dir of commonDirs) {
    const fullPath = path.join(appDir, dir);

    try {
      const statResult = await stat(fullPath);
      if (statResult.isDirectory()) {
        await scanDirectory(fullPath, appDir, assets);
      }
    } catch (e) {
      // Директория не найдена
    }
  }

  // src/migrations
  const srcMigrations = path.join(appDir, "src/migrations");
  try {
    const statResult = await stat(srcMigrations);
    if (statResult.isDirectory()) {
      console.log("   Copying src/migrations → /migrations");
      await scanMigrationsToRoot(srcMigrations, assets);
    }
  } catch (e) {
    // Нет src/migrations
  }

  // API migrations (node_modules/bpium-api/lib/migrations)
  const apiMigrations = path.join(appDir, "node_modules/bpium-api/lib/migrations");
  try {
    const statResult = await stat(apiMigrations);
    if (statResult.isDirectory()) {
      console.log("   Copying bpium-api/lib/migrations");
      const entries = await readdir(apiMigrations, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".js")) {
          const fullPath = path.join(apiMigrations, entry.name);
          const content = await readFile(fullPath);
          assets.set("/migrations/" + entry.name, {
            content: content.toString("base64"),
            encoding: "base64",
          });
        }
      }
    }
  } catch (e) {
    console.log("   ⚠️ No bpium-api migrations found");
  }

  // Локальный API (если есть)
  const localApiPath = path.join(process.cwd(), "node_modules/bpium-api");
  if (existsSync(localApiPath)) {
    const apiMigrationsPath = path.join(localApiPath, "lib/migrations");
    try {
      const statResult = await stat(apiMigrationsPath);
      if (statResult.isDirectory()) {
        console.log("   Copying bpium-api migrations from LOCAL");
        await scanDirectory(apiMigrationsPath, localApiPath, assets);
      }
    } catch (e) {
      console.log("   ⚠️ No bpium-api migrations in local node_modules");
    }
  }

  const nonCodeExtensions = [
    ".sql", ".json", ".yaml", ".yml", ".xml",
    ".txt", ".md", ".csv", ".env", ".pem", ".key", ".cert",
  ];

  try {
    const entries = await readdir(appDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && nonCodeExtensions.some((ext) => entry.name.endsWith(ext))) {
        const fullPath = path.join(appDir, entry.name);
        const content = await readFile(fullPath);
        assets.set("/" + entry.name, {
          content: content.toString("base64"),
          encoding: "base64",
        });
      }
    }
  } catch (e) {
    // Игнорируем ошибки
  }

  return assets;
}

async function scanDirectory(dir, baseDir, assets) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    if (entry.isDirectory()) {
      await scanDirectory(fullPath, baseDir, assets);
    } else {
      const relativePath = path.relative(baseDir, fullPath);
      const content = await readFile(fullPath);

      assets.set("/" + relativePath.replace(/\\/g, "/"), {
        content: content.toString("base64"),
        encoding: "base64",
      });
    }
  }
}

async function findEntryPoint(appDir, customEntry) {
  console.log("🔍 Finding entry point...");

  const possibleEntries = customEntry
    ? [
        customEntry,
        customEntry.replace("src/", "lib/"),
        "lib/index.js",
        "lib/postinstall/index.js",
        "index.js",
        "src/index.js",
      ]
    : ["lib/index.js", "lib/postinstall/index.js", "index.js", "src/index.js", "main.js"];

  for (const entry of possibleEntries) {
    const fullPath = path.join(appDir, entry);
    if (existsSync(fullPath)) {
      console.log(`   Entry: ${entry}`);
      return fullPath;
    }
  }

  throw new Error(`Entry point not found. Tried: ${possibleEntries.join(", ")}`);
}

function generateVFSCode(assets) {
  const entries = Array.from(assets.entries()).map(([filePath, data]) => {
    return `  ${JSON.stringify(filePath)}: {
    content: ${JSON.stringify(data.content)},
    encoding: ${JSON.stringify(data.encoding)}
  }`;
  });

  return `
// ========== NPACK VIRTUAL FILE SYSTEM ==========
const __NPACK_VFS = {
${entries.join(",\n")}
};

// ✅ Проверка что миграции в VFS
console.log("📂 VFS содержит миграции:");
const migrationFiles = Object.keys(__NPACK_VFS).filter(p => p.includes('migrations'));
console.log(\`   Найдено \${migrationFiles.length} файлов миграций\`);
if (migrationFiles.length > 0) {
  console.log("   Примеры:", migrationFiles.slice(0, 5));
}

const { Buffer } = require("buffer");
const __NPACK_ORIG_FS = require("fs");
const __NPACK_READFILE_SYNC = __NPACK_ORIG_FS.readFileSync;
const __NPACK_READFILE = __NPACK_ORIG_FS.promises.readFile;
const __NPACK_EXISTS_SYNC = __NPACK_ORIG_FS.existsSync;
const __NPACK_STAT_SYNC = __NPACK_ORIG_FS.statSync;
const __NPACK_LSTAT_SYNC = __NPACK_ORIG_FS.lstatSync;
const __NPACK_READDIR_SYNC = __NPACK_ORIG_FS.readdirSync;
const __NPACK_READDIR = __NPACK_ORIG_FS.promises.readdir;
const __NPACK_OPENDIR = __NPACK_ORIG_FS.promises.opendir;

// ✅ Node.js SEA (Single Executable Application) support
let __NPACK_SEA = null;
try {
  __NPACK_SEA = require('node:sea');
  console.log('✅ Node.js SEA API detected');
} catch (e) {
  // SEA не поддерживается в этой версии Node.js
}

// ✅ Если используется SEA, перехватываем его методы
if (__NPACK_SEA && __NPACK_SEA.isSea && __NPACK_SEA.isSea()) {
  console.log('🔧 Running as SEA, intercepting sea.getAsset()');
  
  const originalGetAsset = __NPACK_SEA.getAsset;
  const originalGetAssetAsBlob = __NPACK_SEA.getAssetAsBlob;
  const originalGetRawAsset = __NPACK_SEA.getRawAsset;
  
  __NPACK_SEA.getAsset = function(key, encoding) {
    console.log('🔍 SEA getAsset:', key);
    
    const normalized = __NPACK_normalizePath(key);
    if (__NPACK_VFS[normalized]) {
      const data = Buffer.from(__NPACK_VFS[normalized].content, __NPACK_VFS[normalized].encoding);
      if (encoding === 'utf8' || encoding === 'utf-8') {
        return data.toString('utf8');
      }
      return data;
    }
    
    return originalGetAsset.call(this, key, encoding);
  };
  
  __NPACK_SEA.getAssetAsBlob = function(key, options) {
    console.log('🔍 SEA getAssetAsBlob:', key);
    
    const normalized = __NPACK_normalizePath(key);
    if (__NPACK_VFS[normalized]) {
      const data = Buffer.from(__NPACK_VFS[normalized].content, __NPACK_VFS[normalized].encoding);
      return new Blob([data], options);
    }
    
    return originalGetAssetAsBlob.call(this, key, options);
  };
  
  __NPACK_SEA.getRawAsset = function(key) {
    console.log('🔍 SEA getRawAsset:', key);
    
    const normalized = __NPACK_normalizePath(key);
    if (__NPACK_VFS[normalized]) {
      const data = Buffer.from(__NPACK_VFS[normalized].content, __NPACK_VFS[normalized].encoding);
      return data.buffer;
    }
    
    return originalGetRawAsset.call(this, key);
  };
}

// ✅ 1. Вспомогательные функции
function __NPACK_normalizePath(filePath) {
  if (!filePath) return filePath;
  const original = filePath;
  
  let normalized = filePath.toString().split("\\\\").join("/");
  
  if (normalized.startsWith("file://")) {
    normalized = normalized.slice(7);
  }
  
  normalized = normalized.replace(/^[A-Z]:/i, '');
  
  const distIndex = normalized.lastIndexOf('/dist/');
  if (distIndex !== -1) {
    normalized = normalized.slice(distIndex + 5);
  }
  
  if (normalized.startsWith(__dirname)) {
    normalized = normalized.slice(__dirname.length);
  }
  
  while (normalized.includes("//")) {
    normalized = normalized.replace("//", "/");
  }
  
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }
  
  if (original.includes('migrations')) {
    console.log('🔧 normalizePath:', original, '->', normalized);
  }
  
  return normalized;
}

function __NPACK_isInVFS(filePath) {
  const normalized = __NPACK_normalizePath(filePath);
  if (__NPACK_VFS[normalized]) return true;
  for (const vfsPath of Object.keys(__NPACK_VFS)) {
    if (vfsPath === normalized || vfsPath.endsWith(normalized) || normalized.endsWith(vfsPath)) {
      return true;
    }
  }
  return false;
}

function __NPACK_getFromVFS(filePath) {
  const normalized = __NPACK_normalizePath(filePath);
  
  if (__NPACK_VFS[normalized]) {
    console.log('✅ VFS hit (exact):', normalized);
    return __NPACK_VFS[normalized];
  }
  
  for (const [vfsPath, data] of Object.entries(__NPACK_VFS)) {
    if (normalized.endsWith(vfsPath)) {
      console.log('✅ VFS hit (suffix):', vfsPath, 'for', normalized);
      return data;
    }
    
    if (vfsPath.endsWith(normalized)) {
      console.log('✅ VFS hit (prefix):', vfsPath, 'for', normalized);
      return data;
    }
    
    if (vfsPath.includes('/migrations/') && normalized.includes('/migrations/')) {
      const vfsFile = vfsPath.split('/').pop();
      const searchFile = normalized.split('/').pop();
      if (vfsFile === searchFile) {
        console.log('✅ VFS hit (filename):', vfsPath, 'for', normalized);
        return data;
      }
    }
  }
  
  return null;
}

function __NPACK_listVFSDir(dirPath) {
  const normalized = __NPACK_normalizePath(dirPath);
  const files = new Set();
  
  console.log('🔍 VFS listDir:', dirPath, '->', normalized);
  
  for (const vfsPath of Object.keys(__NPACK_VFS)) {
    if (vfsPath.startsWith(normalized + "/")) {
      const relativePath = vfsPath.slice(normalized.length + 1);
      const firstPart = relativePath.split("/")[0];
      if (firstPart) files.add(firstPart);
    }
    
    if (normalized.endsWith('/migrations') || normalized === '/migrations') {
      if (vfsPath.startsWith('/migrations/')) {
        const fileName = vfsPath.split('/migrations/')[1]?.split('/')[0];
        if (fileName && !files.has(fileName)) {
          files.add(fileName);
        }
      }
    }
  }
  
  if (files.size > 0) {
    console.log('✅ VFS listDir found', files.size, 'items');
  } else {
    console.log('⚠️ VFS listDir found nothing');
  }
  
  return files.size > 0 ? Array.from(files) : null;
}

global.__NPACK_listVFSDir = __NPACK_listVFSDir;

// ✅ 2. Knex Custom Migration Source
global.__NPACK_VFS = __NPACK_VFS;

class VFSMigrationSource {
  getMigrations() {
    console.log('🔍 VFS getMigrations called');
    const migrations = Object.keys(__NPACK_VFS)
      .filter(path => path.startsWith('/migrations/') && path.endsWith('.js'))
      .map(path => path.replace('/migrations/', ''))
      .sort();
    console.log('✅ VFS returning', migrations.length, 'migrations');
    return Promise.resolve(migrations);
  }
  
  getMigrationName(migration) {
    return migration;
  }
  
getMigration(migration) {
  const fullPath = '/migrations/' + migration;
  console.log('📄 VFS loading migration:', fullPath);
  
  const vfsData = __NPACK_VFS[fullPath];
  if (!vfsData) {
    throw new Error('Migration not found in VFS: ' + fullPath);
  }
  
  let code = Buffer.from(vfsData.content, vfsData.encoding).toString('utf8');
  
  // ✅ ESM → CJS трансформация
  code = code.replace(/import\\s+(\\w+)\\s+from\\s+['"]([^'"]+)['"];?/g, "const $1 = require('$2');");
  code = code.replace(/import\\s+\\{([^}]+)\\}\\s+from\\s+['"]([^'"]+)['"];?/g, function(match, imports, module) {
    const fixedImports = imports.replace(/(\\w+)\\s+as\\s+(\\w+)/g, '$1: $2');
    return "const {" + fixedImports + "} = require('" + module + "');";
  });
  code = code.replace(/import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+['"]([^'"]+)['"];?/g, "const $1 = require('$2');");
  code = code.replace(/import\\s+['"]([^'"]+)['"];?/g, "require('$1');");
  code = code.replace(/export\\s+async\\s+function\\s+(\\w+)/g, "exports.$1 = async function $1");
  code = code.replace(/export\\s+function\\s+(\\w+)/g, "exports.$1 = function $1");
  code = code.replace(/export\\s+const\\s+(\\w+)\\s*=/g, "const $1 = exports.$1 =");
  code = code.replace(/export\\s+default\\s+/g, "module.exports = ");
  
  const moduleExports = {};
  const fakeModule = { exports: moduleExports };
  
  // ✅ Загружаем реальные модули из бандла
  let bpiumApi, lodash, debugModule;
  try {
    bpiumApi = require('bpium-api');
  } catch (e) {
    console.warn('⚠️ bpium-api not found in bundle');
    bpiumApi = { resources: {}, factory: {}, core: {}, helpers: {} };
  }
  
  try {
    lodash = require('lodash');
  } catch (e) {
    console.warn('⚠️ lodash not found, using partial mock');
    lodash = {
      cloneDeep: (obj) => JSON.parse(JSON.stringify(obj)),
      mapValues: (obj, fn) => Object.keys(obj).reduce((acc, key) => ({ ...acc, [key]: fn(obj[key], key) }), {}),
      merge: Object.assign,
      pick: (obj, keys) => keys.reduce((acc, key) => ({ ...acc, [key]: obj[key] }), {})
    };
  }
  
  try {
    debugModule = require('debug');
  } catch (e) {
    debugModule = function() { return function() {}; };
  }
  
  const moduleCache = {
    'bpium-api': bpiumApi,
    'lodash': lodash,
    'debug': debugModule,
    'fs': require('fs'),
    'path': require('path')
  };
  
  const sandboxRequire = function(id) {
    if (moduleCache[id]) {
      return moduleCache[id];
    }
    
    // Относительные пути - загружаем из VFS
    if (id.startsWith('./') || id.startsWith('../')) {
      const migrationDir = '/migrations';
      let resolvedPath = migrationDir + '/' + id.replace(/^\\.\\.?\\//, '');
      
      const parts = resolvedPath.split('/').filter(Boolean);
      const normalized = [];
      for (const part of parts) {
        if (part === '..') normalized.pop();
        else if (part !== '.') normalized.push(part);
      }
      resolvedPath = '/' + normalized.join('/');
      
      if (!resolvedPath.endsWith('.js')) {
        resolvedPath += '.js';
      }
      
      console.log('🔍 Resolving relative require:', id, '->', resolvedPath);
      
      if (__NPACK_VFS[resolvedPath]) {
        const relMod = { exports: {} };
        const relCode = Buffer.from(__NPACK_VFS[resolvedPath].content, __NPACK_VFS[resolvedPath].encoding).toString('utf8');
        
        try {
          const relWrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', relCode);
          relWrapper.call(relMod.exports, relMod.exports, sandboxRequire, relMod, resolvedPath, '/migrations');
          moduleCache[id] = relMod.exports;
          return relMod.exports;
        } catch (e) {
          console.warn('⚠️ Failed to load relative module:', id, e.message);
          return {};
        }
      }
    }
    
    // Пробуем глобальный require
    try {
      const mod = require(id);
      moduleCache[id] = mod;
      return mod;
    } catch (e) {
      console.warn('⚠️ Module not found:', id);
      moduleCache[id] = {};
      return {};
    }
  };
  
  try {
    const moduleWrapper = new Function(
      'exports',
      'require',
      'module',
      '__filename',
      '__dirname',
      code
    );
    
    moduleWrapper.call(
      moduleExports,
      moduleExports,
      sandboxRequire,
      fakeModule,
      fullPath,
      '/migrations'
    );
    
    console.log('✅ VFS migration loaded:', migration);
    return fakeModule.exports;
  } catch (e) {
    console.error('❌ VFS migration load failed:', e.message);
    console.error('Transformed code:', code.slice(0, 500));
    throw e;
  }
}



}

global.VFSMigrationSource = VFSMigrationSource;

// ✅ 3. Перехватываем knex через Module._load
const OrigModule = require('module');
const origLoad = OrigModule._load;

OrigModule._load = function(request, parent, isMain) {
  const loaded = origLoad.apply(this, arguments);
  
  if (request === 'knex' || request.endsWith('/knex')) {
    console.log('🔧 Knex module loaded, wrapping constructor...');
    
    if (typeof loaded === 'function') {
      const originalKnex = loaded;
      
      const wrappedKnex = function(config) {
        console.log('🔧 Knex() constructor called');
        
        if (config && config.migrations) {
          console.log('📂 Migrations config:', JSON.stringify(config.migrations.directory));
          
          if (!config.migrations.migrationSource && typeof global.VFSMigrationSource !== 'undefined') {
            config.migrations.migrationSource = new global.VFSMigrationSource();
            delete config.migrations.directory;
            console.log('✅ VFS Migration Source injected!');
          }
        }
        
        return originalKnex.call(this, config);
      };
      
      Object.setPrototypeOf(wrappedKnex, originalKnex);
      for (const key in originalKnex) {
        if (originalKnex.hasOwnProperty(key)) {
          wrappedKnex[key] = originalKnex[key];
        }
      }
      
      return wrappedKnex;
    }
  }
  
  return loaded;
};

// ✅ 4. Перехватчики fs
__NPACK_ORIG_FS.readFileSync = function(filePath, options) {
  const vfsData = __NPACK_getFromVFS(filePath);
  if (vfsData) {
    const data = Buffer.from(vfsData.content, vfsData.encoding);
    if (options === "utf8" || options?.encoding === "utf8") {
      return data.toString("utf8");
    }
    return data;
  }
  return __NPACK_READFILE_SYNC.call(this, filePath, options);
};

__NPACK_ORIG_FS.promises.readFile = async function(filePath, options) {
  const vfsData = __NPACK_getFromVFS(filePath);
  if (vfsData) {
    const data = Buffer.from(vfsData.content, vfsData.encoding);
    if (options === "utf8" || options?.encoding === "utf8") {
      return data.toString("utf8");
    }
    return data;
  }
  return __NPACK_READFILE.call(this, filePath, options);
};

__NPACK_ORIG_FS.existsSync = function(filePath) {
  const vfsFiles = __NPACK_listVFSDir(filePath);
  if (vfsFiles !== null) return true;
  if (__NPACK_isInVFS(filePath)) return true;
  return __NPACK_EXISTS_SYNC.call(this, filePath);
};

__NPACK_ORIG_FS.statSync = function(filePath, options) {
  const vfsData = __NPACK_getFromVFS(filePath);
  if (vfsData) {
    const size = Buffer.from(vfsData.content, vfsData.encoding).length;
    return {
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      size: size,
    };
  }
  
  const vfsFiles = __NPACK_listVFSDir(filePath);
  if (vfsFiles !== null) {
    return {
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      size: 0,
    };
  }
  
  return __NPACK_STAT_SYNC.call(this, filePath, options);
};

__NPACK_ORIG_FS.lstatSync = function(filePath, options) {
  return __NPACK_ORIG_FS.statSync(filePath, options);
};

__NPACK_ORIG_FS.readdirSync = function(dirPath, options) {
  const vfsFiles = __NPACK_listVFSDir(dirPath);
  if (vfsFiles) {
    return vfsFiles;
  }
  return __NPACK_READDIR_SYNC.call(this, dirPath, options);
};

__NPACK_ORIG_FS.promises.readdir = async function(dirPath, options) {
  const vfsFiles = __NPACK_listVFSDir(dirPath);
  if (vfsFiles) {
    return vfsFiles;
  }
  return __NPACK_READDIR.call(this, dirPath, options);
};

__NPACK_ORIG_FS.promises.opendir = async function(dirPath, options) {
  const vfsFiles = __NPACK_listVFSDir(dirPath);
  if (vfsFiles) {
    return {
      path: dirPath,
      async *[Symbol.asyncIterator]() {
        for (const file of vfsFiles) {
          yield {
            name: file,
            isFile: () => file.includes('.'),
            isDirectory: () => !file.includes('.'),
            isBlockDevice: () => false,
            isCharacterDevice: () => false,
            isSymbolicLink: () => false,
            isFIFO: () => false,
            isSocket: () => false,
          };
        }
      },
      async read() {
        const file = vfsFiles.shift();
        if (!file) return null;
        return {
          name: file,
          isFile: () => file.includes('.'),
          isDirectory: () => !file.includes('.'),
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isSymbolicLink: () => false,
          isFIFO: () => false,
          isSocket: () => false,
        };
      },
      async close() {},
    };
  }
  
  return __NPACK_OPENDIR.call(this, dirPath, options);
};

console.log("📂 VFS initialized with " + Object.keys(__NPACK_VFS).length + " files");
`;
}

export async function bundle(appDir, outputDir, customEntry = null) {
  console.log("🔍 Finding entry point...");
  const entryPoint = await findEntryPoint(appDir, customEntry);
  console.log(`   Entry: ${path.relative(appDir, entryPoint)}`);

  console.log("📂 Collecting static assets...");
  const assets = await collectAllAssets(appDir);
  console.log(`   Found ${assets.size} files`);

  const outputPath = path.join(outputDir, "bundle.js");
  await mkdir(outputDir, { recursive: true });

  console.log("🔨 Bundling with esbuild...");

  // ✅ Список optional deps которые часто отсутствуют
  const optionalDeps = [
    "sqlite3",
    "mysql",
    "mysql2",
    "pg-query-stream",
    "tedious",
    "oracledb",
    "better-sqlite3",
    "pg-native",
    "cls-bluebird",
    "continuation-local-storage",
  ];

  // ✅ Plugin для патча knex migrations
  const patchKnexMigrationsPlugin = {
    name: "patch-knex-migrations",
    setup(build) {
      build.onLoad({ filter: /import-file\.js$/ }, async (args) => {
        console.log(`   🔧 Patching knex import-file: ${args.path}`);

        const patchedCode = `
console.log('🔧 PATCHED import-file.js loaded');

module.exports = function importFile(filepath) {
  console.log('🔍 importFile called with:', filepath);
  
  // Пробуем загрузить из VFS
  if (typeof global.__NPACK_loadMigrationFromVFS === 'function') {
    var fromVFS = global.__NPACK_loadMigrationFromVFS(filepath);
    if (fromVFS) {
      console.log('✅ Loaded from VFS:', filepath);
      return fromVFS;
    }
  }
  
  // Fallback на обычный require
  console.log('⚠️ Loading from disk:', filepath);
  return require(filepath);
};
`;

        return { contents: patchedCode, loader: "js" };
      });
    },
  };

  const patchKnexFsMigrationsPlugin = {
    name: "patch-knex-fs-migrations",
    setup(build) {
      build.onLoad({ filter: /fs-migrations\.js$/ }, async (args) => {
      let contents = await readFile(args.path, "utf8");

        console.log(`   🔧 Patching knex fs-migrations: ${path.basename(args.path)}`);

        // ✅ Заменяем readdir на VFS-aware версию
        contents = contents.replace(
          /const\s+\{\s*readdir:\s*readdir2\s*\}\s*=\s*require\(['"].*?[']\)/,
          `const { readdir: __nativeReaddir } = require('fs').promises;
const readdir2 = async (dirPath) => {
  console.log('📂 knex readdir:', dirPath);
  
  // Пробуем из VFS
  const normalized = dirPath.replace(/\\\\\\\\/g, '/').replace(/.*\\/dist\\//, '/');
  console.log('   normalized:', normalized);
  
  if (typeof global.__NPACK_VFS !== 'undefined') {
    const files = [];
    for (const vfsPath of Object.keys(global.__NPACK_VFS)) {
      if (vfsPath.startsWith(normalized + '/')) {
        const fileName = vfsPath.slice(normalized.length + 1).split('/')[0];
        if (!files.includes(fileName)) files.push(fileName);
      }
    }
    if (files.length > 0) {
      console.log('   ✅ Found', files.length, 'files in VFS');
      return files;
    }
  }
  
  console.log('   ⚠️ Fallback to native readdir');
  return __nativeReaddir(dirPath);
}`
        );

        return { contents, loader: "js" };
      });
    },
  };

  const patchKnexUtilFsPlugin = {
    name: "patch-knex-util-fs",
    setup(build) {
      build.onLoad({ filter: /knex.*util.*fs\.js$/ }, async (args) => {
      let contents = await readFile(args.path, "utf8");

        console.log(`   🔧 Patching knex util/fs: ${path.basename(args.path)}`);

        contents = contents.replace(
          /const readdir = promisify\(fs\.readdir\);/,
          `const __nativeReaddir = promisify(fs.readdir);
const readdir = async (dirPath, options) => {
  // Нормализуем путь: Windows → Unix style
  let normalized = dirPath.replace(/\\\\\\\\/g, '/');
  
  // Убираем абсолютный путь до /dist/
  const distIndex = normalized.toLowerCase().lastIndexOf('/dist/');
  if (distIndex !== -1) {
    normalized = normalized.slice(distIndex + 5); // +5 = length of "/dist"
  }
  
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  
  // Пробуем найти в VFS
  if (typeof global.__NPACK_VFS !== 'undefined') {
    const files = new Set();
    for (const vfsPath of Object.keys(global.__NPACK_VFS)) {
      if (vfsPath.startsWith(normalized + '/')) {
        const fileName = vfsPath.slice(normalized.length + 1).split('/')[0];
        if (fileName) files.add(fileName);
      }
    }
    if (files.size > 0) {
      console.log('✅ VFS readdir:', normalized, '→', files.size, 'files');
      return Array.from(files);
    }
  }
  
  // Fallback
  return __nativeReaddir(dirPath, options);
};`
        );

        return { contents, loader: "js" };
      });
    },
  };

  // В bundler/index.js - добавь новый плагин:

const patchKnexMigratePlugin = {
  name: "patch-knex-migrate",
  setup(build) {
    // ✅ Патчим FsMigrations.getMigrations - это КЛЮЧЕВОЙ метод
    build.onLoad({ filter: /fs-migrations\.js$/ }, async (args) => {
      let contents = await readFile(args.path, "utf8");
      
      console.log(`   🔧 Patching FsMigrations.getMigrations: ${args.path}`);
      
      // Полностью заменяем класс FsMigrations
      contents = `
console.log('🔧 PATCHED fs-migrations.js loaded');

class FsMigrations {
  constructor(migrationDirectories, sortDirsSeparately, loadExtensions) {
    this.sortDirsSeparately = sortDirsSeparately;
    this.config = { directory: migrationDirectories, loadExtensions };
  }

  async getMigrations(loadExtensions) {
    console.log('🔍 FsMigrations.getMigrations called');
    
    // ✅ ВСЕГДА используем VFS
    if (typeof global.VFSMigrationSource !== 'undefined') {
      const vfs = new global.VFSMigrationSource();
      const migrations = await vfs.getMigrations();
      console.log('✅ VFS returned', migrations.length, 'migrations');
      return migrations;
    }
    
    console.error('❌ VFSMigrationSource not available!');
    throw new Error('VFS Migration Source not initialized');
  }

  getMigrationName(migration) {
    return migration;
  }

  async getMigration(migration) {
    console.log('📄 FsMigrations.getMigration:', migration);
    
    if (typeof global.VFSMigrationSource !== 'undefined') {
      const vfs = new global.VFSMigrationSource();
      return vfs.getMigration(migration);
    }
    
    throw new Error('VFS not available');
  }
}

module.exports = FsMigrations;
`;
      
      return { contents, loader: "js" };
    });
  },
};


const patchPostinstallPlugin = {
  name: "patch-postinstall",
  setup(build) {
    build.onLoad({ filter: /postinstall.*index\.js$/ }, async (args) => {
      let contents = await readFile(args.path, "utf8");
      
      console.log(`   🔧 Patching postinstall/index.js`);
      
      // Ищем knex migrate вызов
      contents = contents.replace(
        /(await\s+knex\.migrate\.[^(]+\([^)]*)\)/g,
        `$1, {
  migrationSource: new global.__NPACK_KnexMigrationSource()
})`
      );
      
      // Или если knex уже создан:
      contents = contents.replace(
        /const\s+knex\s*=\s*require\(['"]knex['"]\)\((.*?)\)/gs,
        `const knex = require('knex')((function(config) {
  if (config && config.migrations) {
    config.migrations.migrationSource = new global.__NPACK_KnexMigrationSource();
    console.log('✅ Using VFS migrations');
  }
  return config;
})($1))`
      );
      
      return { contents, loader: "js" };
    });
  },
};

const patchKnexConfigPlugin = {
  name: "patch-knex-config",
  setup(build) {
    // Патчим любой файл который создает knex instance
    build.onLoad({ filter: /\.(js|ts)$/ }, async (args) => {
      let contents = await readFile(args.path, "utf8");
      
      // Пропускаем node_modules кроме случаев где явно создается knex
      if (args.path.includes('node_modules') && !contents.includes('knex(')) {
        return null;
      }
      
      // Ищем паттерны создания knex
      const knexPatterns = [
        /const\s+(\w+)\s*=\s*require\(['"]knex['"]\)\s*\(/g,
        /import\s+knex\s+from\s+['"]knex['"][\s\S]*?knex\s*\(/g,
        /=\s*knex\s*\(\s*\{/g
      ];
      
      let modified = false;
      
      // Патчим knex initialization
      if (contents.match(/knex\s*\(/)) {
        console.log(`   🔧 Patching knex config in: ${args.path}`);
        
        // Добавляем VFS Migration Source в конфиг
        contents = contents.replace(
          /knex\s*\(\s*\{/g,
          `knex((function(cfg) {
  if (cfg && cfg.migrations && typeof global.VFSMigrationSource !== 'undefined') {
    console.log('✅ Injecting VFS Migration Source');
    cfg.migrations.migrationSource = new global.VFSMigrationSource();
  }
  return cfg;
})({`
        );
        
        // Закрываем обертку
        contents = contents.replace(
          /\}\s*\)\s*;/g,
          '}))'
        );
        
        modified = true;
      }
      
      if (modified) {
        return { contents, loader: "js" };
      }
      
      return null;
    });
  },
};

const patchKnexfilePlugin = {
  name: "patch-knexfile",
  setup(build) {
    build.onLoad({ filter: /knexfile\.js$/ }, async (args) => {
      let contents = await readFile(args.path, "utf8");
      
      console.log(`   🔧 Patching knexfile.js: ${args.path}`);
      
      // Удаляем строку с directory
      contents = contents.replace(
        /directory:\s*path\.join\(__dirname,\s*['"]\.\/migrations['"]\),?/g,
        ''
      );
      
      // Добавляем migrationSource ПОСЛЕ tableName
      contents = contents.replace(
        /(tableName:\s*['"][^'"]+['"],?)/,
        `$1
  migrationSource: typeof global.VFSMigrationSource !== 'undefined' ? new global.VFSMigrationSource() : null,`
      );
      
      // Добавляем лог
      contents = contents.replace(
        /module[.\s]*exports\s*=/,
        `console.log('🔧 PATCHED knexfile.js loaded');
module.exports =`
      );
      
      return { contents, loader: "js" };
    });
  },
};




  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: outputPath,
    banner: {
      js: `
console.log("🛡️ VFS PRELOAD");

const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(id) {
  const result = originalRequire.apply(this, arguments);
  
  if (id === 'knex' && typeof result === 'function') {
    console.log('✅ Knex intercepted in preload!');
    const originalKnex = result;
    
    return function(config) {
      console.log('🔧 Knex() called with config');
      
      if (config && config.migrations) {
        console.log('📂 Original migrations dir:', config.migrations.directory);
        
        if (typeof global.VFSMigrationSource !== 'undefined') {
          config.migrations.migrationSource = new global.VFSMigrationSource();
          delete config.migrations.directory;
          console.log('✅ VFS Migration Source injected');
        } else {
          console.warn('⚠️ VFSMigrationSource not available yet');
        }
      }
      
      return originalKnex.call(this, config);
    };
  }
  
  return result;
};

${generateVFSCode(assets).trim()}
`,
    },
      // ✅ FORCE BUNDLE ВСЕХ NODE_MODULES
     packages: 'bundle',
    external: optionalDeps,
    minify: false,
    sourcemap: false,
    mainFields: ['main', 'module'],
    conditions: ['node', 'require', 'default'],
    resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".css", ".json"],
    loader: {
      ".js": "jsx",
      ".jsx": "jsx",
      ".ts": "ts",
      ".tsx": "tsx",
    },
    logLevel: "warning",
    keepNames: true,
    inject: [],
    plugins: [
      patchKnexfilePlugin,
      patchPostinstallPlugin,
      patchKnexMigrationsPlugin,
      patchKnexFsMigrationsPlugin,
      patchKnexUtilFsPlugin,
      patchKnexMigratePlugin
    ],
  });

  console.log(`✅ Bundle created: ${outputPath}`);
  return outputPath;
}

// CLI интерфейс - исправленная проверка для Windows
const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] === __filename || process.argv[1] === __filename.replace(/\\/g, "/");

if (isMainModule) {
  (async () => {
    const appDir = process.argv[2];
    const outputDir = process.argv[3] || "./dist";

    let customEntry = null;
    const entryIndex = process.argv.indexOf("--entry");
    if (entryIndex !== -1 && process.argv[entryIndex + 1]) {
      customEntry = process.argv[entryIndex + 1];
    }

    if (!appDir) {
      console.error("Usage: node bundler/index.js <app-dir> [output-dir] [--entry <file>]");
      process.exit(1);
    }

    try {
      console.log("📋 Starting bundler...");
      console.log("   appDir:", appDir);
      console.log("   outputDir:", outputDir);
      console.log("   customEntry:", customEntry);

      await bundle(appDir, outputDir, customEntry);

      console.log("✅ Bundler completed successfully");
    } catch (err) {
      console.error("❌ Bundler Error:", err.message);
      console.error("Stack:", err.stack);
      process.exit(1);
    }
  })();
}
