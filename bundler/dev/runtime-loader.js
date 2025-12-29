// bundler/runtime-loader.js
const fs = require('fs');
const path = require('path');

// ✅ СОЗДАЁМ ВИРТУАЛЬНУЮ /snapshot/ директорию
const SNAPSHOT_PREFIX = process.platform === 'win32' ? 'C:\\snapshot\\' : '/snapshot/';

// ✅ ПАТЧИМ process.cwd() - миграции ищут относительно cwd!
const originalCwd = process.cwd.bind(process);
process.cwd = function() {
  if (process.env.PKG_CWD) {
    return process.env.PKG_CWD;
  }
  return SNAPSHOT_PREFIX + 'app';
};

// ✅ ПАТЧИМ fs.readdirSync для миграций
const originalReaddirSync = fs.readdirSync;
fs.readdirSync = function(dirPath, options) {
  const normalized = String(dirPath).replace(/\\/g, '/');
  
  // Если путь внутри snapshot
  if (normalized.startsWith(SNAPSHOT_PREFIX) || normalized.includes('migrations')) {
    const files = [];
    const searchPath = normalized.replace(SNAPSHOT_PREFIX, '/');
    
    for (const [vfsPath] of VFS) {
      if (vfsPath.startsWith(searchPath) && vfsPath !== searchPath) {
        const relativePath = vfsPath.substring(searchPath.length + 1);
        const fileName = relativePath.split('/')[0];
        if (!files.includes(fileName)) {
          files.push(fileName);
        }
      }
    }
    
    return files;
  }
  
  return originalReaddirSync.call(this, dirPath, options);
};
