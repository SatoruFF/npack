import esbuild from "esbuild";
import fs from "fs/promises";
import path from "path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

/**
 * Анализирует код и находит все динамические пути
 */
async function analyzeDynamicPaths(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  const dynamicPaths = new Set();
  
  try {
    const ast = parse(source, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx"],
    });

    traverse.default(ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        
        // Ищем path.join(__dirname, ...)
        if (
          callee.type === "MemberExpression" &&
          callee.object.name === "path" &&
          callee.property.name === "join"
        ) {
          const args = path.node.arguments;
          if (args.length >= 2 && args[0].name === "__dirname") {
            if (args[1].type === "StringLiteral") {
              dynamicPaths.add(args[1].value);
            }
          }
        }
        
        // Ищем fs.readFileSync/readFile
        if (
          callee.type === "MemberExpression" &&
          (callee.property.name === "readFileSync" || 
           callee.property.name === "readFile")
        ) {
          // Пометить файл как использующий динамические пути
          dynamicPaths.add("__dynamic__");
        }
      },
    });
  } catch (e) {
    console.warn(`Cannot parse ${filePath}: ${e.message}`);
  }

  return dynamicPaths;
}

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
 * Генерирует VFS код с полным перехватом путей
 */
function generateVFSCode(assets, appDir) {
  const entries = Array.from(assets.entries()).map(([filePath, data]) => {
    return `  ${JSON.stringify(filePath)}: {
    content: ${JSON.stringify(data.content)},
    encoding: ${JSON.stringify(data.encoding)}
  }`;
  });

  return `
// ========== VIRTUAL FILE SYSTEM ==========
const __vfs = {
${entries.join(",\n")}
};

// Оригинальные функции
import { Buffer } from "buffer";
import * as originalFs from "fs";
const originalReadFileSync = originalFs.readFileSync;
const originalReadFile = originalFs.promises.readFile;
const originalExistsSync = originalFs.existsSync;
const originalStatSync = originalFs.statSync;
const originalReaddirSync = originalFs.readdirSync;

// Нормализация путей
function normalizePath(filePath) {
  if (!filePath) return filePath;
  
  let normalized = filePath.toString().replace(/\\\\/g, "/");
  
  // Убираем префикс file://
  if (normalized.startsWith("file://")) {
    normalized = normalized.slice(7);
  }
  
  // Если путь относительный, делаем его абсолютным относительно __dirname
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }
  
  return normalized;
}

// Проверка наличия файла в VFS
function isInVFS(filePath) {
  const normalized = normalizePath(filePath);
  if (__vfs[normalized]) return true;
  
  // Проверяем все варианты пути
  for (const vfsPath of Object.keys(__vfs)) {
    if (vfsPath.endsWith(normalized) || normalized.endsWith(vfsPath)) {
      return true;
    }
  }
  
  return false;
}

// Получение файла из VFS
function getFromVFS(filePath) {
  const normalized = normalizePath(filePath);
  
  if (__vfs[normalized]) {
    return __vfs[normalized];
  }
  
  // Ищем по окончанию пути
  for (const [vfsPath, data] of Object.entries(__vfs)) {
    if (vfsPath.endsWith(normalized) || normalized.endsWith(vfsPath)) {
      return data;
    }
  }
  
  return null;
}

// ===== ПЕРЕХВАТ fs.readFileSync =====
originalFs.readFileSync = function(filePath, options) {
  const vfsData = getFromVFS(filePath);
  
  if (vfsData) {
    const data = Buffer.from(vfsData.content, vfsData.encoding);
    if (options === "utf8" || options?.encoding === "utf8") {
      return data.toString("utf8");
    }
    return data;
  }
  
  return originalReadFileSync.call(this, filePath, options);
};

// ===== ПЕРЕХВАТ fs.promises.readFile =====
originalFs.promises.readFile = async function(filePath, options) {
  const vfsData = getFromVFS(filePath);
  
  if (vfsData) {
    const data = Buffer.from(vfsData.content, vfsData.encoding);
    if (options === "utf8" || options?.encoding === "utf8") {
      return data.toString("utf8");
    }
    return data;
  }
  
  return originalReadFile.call(this, filePath, options);
};

// ===== ПЕРЕХВАТ fs.existsSync =====
originalFs.existsSync = function(filePath) {
  if (isInVFS(filePath)) {
    return true;
  }
  return originalExistsSync.call(this, filePath);
};

// ===== ПЕРЕХВАТ fs.statSync =====
originalFs.statSync = function(filePath, options) {
  const vfsData = getFromVFS(filePath);
  
  if (vfsData) {
    const size = Buffer.from(vfsData.content, vfsData.encoding).length;
    return {
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      size: size,
    };
  }
  
  return originalStatSync.call(this, filePath, options);
};

// ===== ПЕРЕХВАТ fs.readdirSync =====
originalFs.readdirSync = function(dirPath, options) {
  const normalized = normalizePath(dirPath);
  const files = new Set();
  
  // Ищем файлы в VFS с этим префиксом
  for (const vfsPath of Object.keys(__vfs)) {
    if (vfsPath.startsWith(normalized + "/")) {
      const relativePath = vfsPath.slice(normalized.length + 1);
      const firstPart = relativePath.split("/")[0];
      files.add(firstPart);
    }
  }
  
  if (files.size > 0) {
    return Array.from(files);
  }
  
  return originalReaddirSync.call(this, dirPath, options);
};

// Экспортируем перехваченный fs
export default originalFs;
export const readFileSync = originalFs.readFileSync;
export const readFile = originalFs.promises.readFile;
export const existsSync = originalFs.existsSync;
export const statSync = originalFs.statSync;
export const readdirSync = originalFs.readdirSync;
export const promises = {
  readFile: originalFs.promises.readFile,
  readdir: originalFs.promises.readdir,
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

  console.log("🔨 Bundling with esbuild...");
  
  const vfsCode = generateVFSCode(assets, appDir);

  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: outputPath,
    target: "node20",
    banner: {
      js: `
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname } from "path";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

${vfsCode}
      `.trim(),
    },
    external: [],
    minify: false,
    sourcemap: false,
    logLevel: "info",
    mainFields: ["module", "main"],
  });

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