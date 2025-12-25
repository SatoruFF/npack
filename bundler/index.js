import esbuild from "esbuild";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

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
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        await scanDirectory(fullPath, appDir, assets);
      }
    } catch (e) {
      // Директория не найдена
    }
  }

  const nonCodeExtensions = [
    ".sql",
    ".json",
    ".yaml",
    ".yml",
    ".xml",
    ".txt",
    ".md",
    ".csv",
    ".env",
    ".pem",
    ".key",
    ".cert",
  ];

  try {
    const entries = await fs.readdir(appDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && nonCodeExtensions.some((ext) => entry.name.endsWith(ext))) {
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

async function findEntryPoint(appDir, customEntry = null) {
  if (customEntry) {
    const fullPath = path.join(appDir, customEntry);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch (e) {
      // ✅ Если не найден, попробуй src/ версию (для Babel)
      const srcPath = path.join(appDir, 'src', customEntry);
      try {
        await fs.access(srcPath);
        console.log(`   Using source version: src/${customEntry}`);
        return srcPath;
      } catch {
        throw new Error(`Entry point not found: ${customEntry}`);
      }
    }
  }

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
    const candidates = ["index.js", "index.mjs", "index.ts", "src/index.js", "src/index.ts", "src/main.js"];

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

function __NPACK_normalizePath(filePath) {
  if (!filePath) return filePath;
  let normalized = filePath.toString().replace(/\\\\/g, "/");
  if (normalized.startsWith("file://")) {
    normalized = normalized.slice(7);
  }
  if (normalized.startsWith(__dirname)) {
    normalized = normalized.slice(__dirname.length);
  }
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
  for (const vfsPath of Object.keys(__NPACK_VFS)) {
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

export async function bundle(appDir, outputDir, customEntry = null) {
  console.log("🔍 Finding entry point...");
  const entryPoint = await findEntryPoint(appDir, customEntry);
  console.log(`   Entry: ${path.relative(appDir, entryPoint)}`);

  console.log("📂 Collecting static assets...");
  const assets = await collectAllAssets(appDir);
  console.log(`   Found ${assets.size} files`);

  const outputPath = path.join(outputDir, "bundle.js");
  await fs.mkdir(outputDir, { recursive: true });

  console.log("🔨 Bundling with esbuild...");

  // ✅ Список optional deps которые часто отсутствуют
  const optionalDeps = [
    'sqlite3', 'mysql', 'mysql2', 'pg-query-stream', 'tedious', 'oracledb',
    'better-sqlite3', 'pg-native', 'cls-bluebird', 'continuation-local-storage'
  ];

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: outputPath,
    banner: {
      js: `console.log("🛡️ VFS LOADED");\n\n${generateVFSCode(assets).trim()}\n`,
    },
    external: optionalDeps,  // ✅ Не бандлим optional deps
    minify: false,
    sourcemap: false,
    resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".css", ".json"],
    loader: {
      '.js': 'jsx',
      '.jsx': 'jsx',
      '.ts': 'ts',
      '.tsx': 'tsx',
    },
    logLevel: 'warning',
    // ✅ Игнорируем ошибки переприсваивания const (legacy code)
    // legalComments: 'none',
    keepNames: true,
    // ✅ Добавляем shims для отсутствующих модулей
    inject: [],
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
