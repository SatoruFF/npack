import swc from "@swc/core";
import fs from "fs/promises";
import path from "path";
import * as babelParser from "@babel/parser";
import babelGenerate from "@babel/generator";
import babelTraverse from "@babel/traverse";

/**
 * Собирает все статические ассеты и динамически найденные файлы
 */
async function collectAllAssets(appDir, scannedFiles = new Set()) {
  const assets = new Map();

  // Стандартные директории со статикой
  const commonDirs = [
    "config", "templates", "public", "assets", "data", 
    "migrations", "views", "locale", "locales", "i18n",
    "static", "resources", "sql", "queries"
  ];

  // Сканируем стандартные директории
  for (const dir of commonDirs) {
    const fullPath = path.join(appDir, dir);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        await scanDirectory(fullPath, appDir, assets);
      }
    } catch (e) {
      // Директория не найдена - пропускаем
    }
  }

  // Сканируем файлы с нестандартными расширениями в корне проекта
  const nonCodeExtensions = [
    ".sql", ".json", ".yaml", ".yml", ".xml", ".txt", 
    ".md", ".csv", ".env", ".pem", ".key", ".cert"
  ];
  
  try {
    const entries = await fs.readdir(appDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && nonCodeExtensions.some(ext => entry.name.endsWith(ext))) {
        const fullPath = path.join(appDir, entry.name);
        const content = await fs.readFile(fullPath);
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
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    
    if (entry.isDirectory()) {
      await scanDirectory(fullPath, baseDir, assets);
    } else {
      const relativePath = path.relative(baseDir, fullPath);
      const content = await fs.readFile(fullPath);
      
      assets.set("/" + relativePath.replace(/\\/g, "/"), {
        content: content.toString("base64"),
        encoding: "base64",
      });
    }
  }
}

/**
 * Находит entry point из package.json
 */
async function findEntryPoint(appDir) {
  const packageJsonPath = path.join(appDir, "package.json");
  
  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
    
    if (packageJson.bin) {
      if (typeof packageJson.bin === "string") {
        return path.join(appDir, packageJson.bin);
      } else {
        const firstBin = Object.values(packageJson.bin)[0];
        return path.join(appDir, firstBin);
      }
    }
    
    if (packageJson.main) {
      return path.join(appDir, packageJson.main);
    }
    
    return path.join(appDir, "index.js");
  } catch (e) {
    const candidates = [
      "index.js", "index.mjs", "index.ts", 
      "src/index.js", "src/index.ts", "src/main.js"
    ];
    
    for (const candidate of candidates) {
      const fullPath = path.join(appDir, candidate);
      try {
        await fs.access(fullPath);
        return fullPath;
      } catch (e) {
        continue;
      }
    }
    
    throw new Error("Could not find entry point");
  }
}

/**
 * Генерирует VFS код с полным перехватом путей (уникальные имена)
 */
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

const { Buffer } = require("buffer");
const __NPACK_ORIG_FS = require("fs");
const __NPACK_READFILE_SYNC = __NPACK_ORIG_FS.readFileSync;
const __NPACK_READFILE = __NPACK_ORIG_FS.promises.readFile;
const __NPACK_EXISTS_SYNC = __NPACK_ORIG_FS.existsSync;
const __NPACK_STAT_SYNC = __NPACK_ORIG_FS.statSync;
const __NPACK_READDIR_SYNC = __NPACK_ORIG_FS.readdirSync;
const __NPACK_READDIR = __NPACK_ORIG_FS.promises.readdir;

// Нормализация путей (с поддержкой абсолютных)
function __NPACK_normalizePath(filePath) {
  if (!filePath) return filePath;
  
  let normalized = filePath.toString().replace(/\\\\/g, "/");
  
  if (normalized.startsWith("file://")) {
    normalized = normalized.slice(7);
  }
  
  // ✅ Если путь абсолютный и содержит __dirname, вырезаем префикс
  if (normalized.startsWith(__dirname)) {
    normalized = normalized.slice(__dirname.length);
  }
  
  // Убираем двойные слэши
  normalized = normalized.replace(/\\/\\/+/g, "/");
  
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
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
    return __NPACK_VFS[normalized];
  }
  
  for (const [vfsPath, data] of Object.entries(__NPACK_VFS)) {
    if (vfsPath === normalized || vfsPath.endsWith(normalized) || normalized.endsWith(vfsPath)) {
      return data;
    }
  }
  
  return null;
}

function __NPACK_listVFSDir(dirPath) {
  const normalized = __NPACK_normalizePath(dirPath);
  const files = new Set();
  
  // ✅ Ищем файлы в VFS с этим префиксом
  for (const vfsPath of Object.keys(__NPACK_VFS)) {
    // Точное совпадение директории или поддиректория
    if (vfsPath.startsWith(normalized + "/") || (normalized === "/" && vfsPath.startsWith("/"))) {
      const relativePath = vfsPath.slice(normalized.length + 1);
      if (relativePath) {
        const firstPart = relativePath.split("/")[0];
        files.add(firstPart);
      }
    }
  }
  
  return files.size > 0 ? Array.from(files) : null;
}

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
  if (__NPACK_isInVFS(filePath)) {
    return true;
  }
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
  return __NPACK_STAT_SYNC.call(this, filePath, options);
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
`;
}


/**
 * Главная функция бандлинга
 */
export async function bundle(appDir, outputDir) {
  console.log("🔍 Finding entry point...");
  const entryPoint = await findEntryPoint(appDir);
  console.log(`   Entry: ${path.relative(appDir, entryPoint)}`);

  console.log("📂 Collecting static assets...");
  const assets = await collectAllAssets(appDir);
  console.log(`   Found ${assets.size} files`);

  const outputPath = path.join(outputDir, "bundle.js");
  await fs.mkdir(outputDir, { recursive: true });

  console.log("🔨 Bundling with SWC...");

  const result = await swc.transformFile(entryPoint, {
    jsc: {
      target: "es2022",
      parser: {
        syntax: "ecmascript",
        dynamicImport: true,
      },
      transform: {
        legacyDecorator: false,
        decoratorMetadata: false,
      },
    },
    module: {
      type: "commonjs",
    },
    sourceMaps: false,
    inlineSourcesContent: false,
  });

  // ✅ AST-очистка (полная версия с заменой всех _path/_url)
  const ast = babelParser.parse(result.code, {
    sourceType: "module",
    plugins: [],
  });

  babelTraverse.default(ast, {
    // 1. Удаляем объявления переменных
    VariableDeclaration(path) {
      const declarations = path.node.declarations;
      
      const filtered = declarations.filter(decl => {
        if (decl.id.type === 'Identifier') {
          const name = decl.id.name;
          return name !== '__dirname' && 
                 name !== '__filename' && 
                 name !== '__filename1' &&
                 name !== '_url' && 
                 name !== '_path';
        }
        return true;
      });

      if (filtered.length === 0) {
        path.remove();
      } else if (filtered.length !== declarations.length) {
        path.node.declarations = filtered;
      }
    },

    // 2. Заменяем ВСЕ _path.* и _path.default.*
    MemberExpression(path) {
      const { object, property } = path.node;
      
      // _path.default.join/dirname/etc → require('path').join/dirname
      if (object.type === 'MemberExpression' &&
          object.object.name === '_path' &&
          object.property.name === 'default') {
        path.node.object = {
          type: 'CallExpression',
          callee: { type: 'Identifier', name: 'require' },
          arguments: [{ type: 'StringLiteral', value: 'path' }]
        };
      }
      
      // _path.join/dirname → require('path').join/dirname
      if (object.name === '_path') {
        path.node.object = {
          type: 'CallExpression',
          callee: { type: 'Identifier', name: 'require' },
          arguments: [{ type: 'StringLiteral', value: 'path' }]
        };
      }

      // _url.default.fileURLToPath → удаляем полностью (см. CallExpression)
      if (object.type === 'MemberExpression' &&
          object.object.name === '_url' &&
          object.property.name === 'default') {
        // Обработается в CallExpression
      }
    },

    // 3. Заменяем вызовы _url.fileURLToPath на __filename
    CallExpression(path) {
      const { callee } = path.node;
      
      // (0, _url.fileURLToPath)(...) → __filename
      if (callee.type === 'SequenceExpression') {
        const lastExpr = callee.expressions[callee.expressions.length - 1];
        if (lastExpr.type === 'MemberExpression' &&
            lastExpr.object?.name === '_url' &&
            lastExpr.property?.name === 'fileURLToPath') {
          path.replaceWith({
            type: 'Identifier',
            name: '__filename'
          });
        }
      }
      
      // _url.fileURLToPath(...) → __filename
      if (callee.type === 'MemberExpression' &&
          callee.object.name === '_url' &&
          callee.property.name === 'fileURLToPath') {
        path.replaceWith({
          type: 'Identifier',
          name: '__filename'
        });
      }

      // _url.default.fileURLToPath(...) → __filename
      if (callee.type === 'MemberExpression' &&
          callee.object?.type === 'MemberExpression' &&
          callee.object.object?.name === '_url' &&
          callee.object.property?.name === 'default' &&
          callee.property?.name === 'fileURLToPath') {
        path.replaceWith({
          type: 'Identifier',
          name: '__filename'
        });
      }
    }
  });

  const cleanedCode = babelGenerate.default(ast, {
    retainLines: false,
    compact: false,
  }).code;

  const finalCode = `
console.log("🛡️ VFS LOADED");

${generateVFSCode(assets).trim()}

${cleanedCode}
  `.trim();

  await fs.writeFile(outputPath, finalCode, "utf8");
  console.log(`✅ Bundle created: ${outputPath}`);
  return outputPath;
}


// CLI интерфейс
if (import.meta.url === `file://${process.argv[1]}`) {
  const appDir = process.argv[2];
  const outputDir = process.argv[3] || "./dist";

  if (!appDir) {
    console.error("Usage: node bundler/index.js <app-dir> [output-dir]");
    process.exit(1);
  }

  bundle(appDir, outputDir).catch((err) => {
    console.error("❌ Error:", err);
    console.error(err.stack);
    process.exit(1);
  });
}
