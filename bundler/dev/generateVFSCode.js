export function generateVFSCode(assets) {
  console.log("\n📦 VFS CONTENTS:");
  const migrationFiles = Array.from(assets.keys()).filter((p) => p.includes("migrations"));
  const serviceFiles = migrationFiles.filter((p) => p.includes("services"));
  const helperFiles = migrationFiles.filter((p) => p.includes("helpers"));

  console.log("   Total migration files:", migrationFiles.length);
  console.log("   Services:", serviceFiles.length, serviceFiles.slice(0, 5));
  console.log("   Helpers:", helperFiles.length, helperFiles.slice(0, 5));
  console.log("");

  const entries = Array.from(assets.entries()).map(([filePath, data]) => {
    return `  ${JSON.stringify(filePath)}: {
    content: ${JSON.stringify(data.content)},
    encoding: ${JSON.stringify(data.encoding)}
  }`;
  });

  return `

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
        }
      }
      
      return originalKnex.call(this, config);
    };
  }
  
  return result;
};

// ========== NPACK VIRTUAL FILE SYSTEM ==========
const __NPACK_VFS = {
${entries.join(",\n")}
};

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
const __NPACK_SCANDIR = __NPACK_ORIG_FS.promises.scandir;

let __NPACK_SEA = null;
try {
  __NPACK_SEA = require('node:sea');
  console.log('✅ Node.js SEA API detected');
} catch (e) {}

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
    
    let bpiumApi, lodash, debugModule;
    try {
      bpiumApi = require('bpium-api');
      console.log('✅ bpium-api loaded from bundle');
    } catch (e) {
      console.warn('⚠️ bpium-api not found in bundle');
      bpiumApi = { resources: {}, factory: {}, core: {}, helpers: {} };
    }
    
    try {
      lodash = require('lodash');
      console.log('✅ lodash loaded from bundle');
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
      console.log('✅ debug loaded from bundle');
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

__NPACK_ORIG_FS.promises.scandir = async function(dirPath, options) {
  console.log('🔍 VFS scandir called:', dirPath);
  
  const vfsFiles = __NPACK_listVFSDir(dirPath);
  if (vfsFiles) {
    console.log('✅ VFS scandir found', vfsFiles.length, 'files');
    return vfsFiles.map(name => ({
      name,
      isFile: () => name.includes('.'),
      isDirectory: () => !name.includes('.'),
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    }));
  }
  
  if (__NPACK_SCANDIR) {
    return __NPACK_SCANDIR.call(this, dirPath, options);
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
