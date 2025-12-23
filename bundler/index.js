import esbuild from "esbuild";
import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";

/**
 * Plugin for scanning and inline files that are uploaded via fs
 */
const virtualFileSystemPlugin = {
  name: "vfs",
  setup(build) {
    const vfsFiles = new Map();

    build.onLoad({ filter: /\.(js|ts|mjs|cjs)$/ }, async (args) => {
      const source = await fs.readFile(args.path, "utf8");
      
      // find patters fs.readFileSync, fs.readFile with path.join
      const patterns = [
        /fs\.readFileSync\s*\(\s*path\.join\s*\([^)]+\)[^)]*\)/g,
        /fs\.promises\.readFile\s*\(\s*path\.join\s*\([^)]+\)[^)]*\)/g,
        /readFileSync\s*\(\s*path\.join\s*\([^)]+\)[^)]*\)/g,
      ];

      let modified = source;
      const baseDir = path.dirname(args.path);

    // Here you can add more complex AST analysis logic
      // For now, just note that the file can use dynamic paths
      
      return {
        contents: source,
        loader: args.path.endsWith(".ts") ? "ts" : "js",
      };
    });
  },
};

/**
 * Scans the directory and collects all the files for VFS
 */
async function collectStaticAssets(appDir) {
  const assets = new Map();
  const commonDirs = ["config", "templates", "public", "assets", "data"];

  for (const dir of commonDirs) {
    const fullPath = path.join(appDir, dir);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        await scanDirectory(fullPath, appDir, assets);
      }
    } catch (e) {
      // Cannot find directory( just skip
    }
  }

  return assets;
}

async function scanDirectory(dir, baseDir, assets) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      await scanDirectory(fullPath, baseDir, assets);
    } else {
      const relativePath = path.relative(baseDir, fullPath);
      const content = await fs.readFile(fullPath);
      const base64 = content.toString("base64");
      
      assets.set("/" + relativePath.replace(/\\/g, "/"), {
        content: base64,
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
    
    // Priority: bin > main > index.js
    if (packageJson.bin) {
      if (typeof packageJson.bin === "string") {
        return path.join(appDir, packageJson.bin);
      } else {
        // Берем первый bin
        const firstBin = Object.values(packageJson.bin)[0];
        return path.join(appDir, firstBin);
      }
    }
    
    if (packageJson.main) {
      return path.join(appDir, packageJson.main);
    }
    
    // Fallback на index.js
    return path.join(appDir, "index.js");
  } catch (e) {
    // if cannot find package.json, check standalone files
    const candidates = ["index.js", "index.mjs", "index.ts", "src/index.js", "src/index.ts"];
    
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
 * Generate VFS code
 */
function generateVFSCode(assets) {
  const entries = Array.from(assets.entries()).map(([path, data]) => {
    return `  ${JSON.stringify(path)}: {
    content: ${JSON.stringify(data.content)},
    encoding: ${JSON.stringify(data.encoding)}
  }`;
  });

  return `
// Virtual File System
const __vfs = {
${entries.join(",\n")}
};

import { Buffer } from "buffer";
const originalReadFileSync = fs.readFileSync;
const originalReadFile = fs.promises.readFile;

fs.readFileSync = function(filePath, options) {
  const normalized = filePath.toString().replace(/\\\\/g, "/");
  
  if (__vfs[normalized]) {
    const data = Buffer.from(__vfs[normalized].content, __vfs[normalized].encoding);
    if (options === "utf8" || options?.encoding === "utf8") {
      return data.toString("utf8");
    }
    return data;
  }
  
  return originalReadFileSync(filePath, options);
};

fs.promises.readFile = async function(filePath, options) {
  const normalized = filePath.toString().replace(/\\\\/g, "/");
  
  if (__vfs[normalized]) {
    const data = Buffer.from(__vfs[normalized].content, __vfs[normalized].encoding);
    if (options === "utf8" || options?.encoding === "utf8") {
      return data.toString("utf8");
    }
    return data;
  }
  
  return originalReadFile(filePath, options);
};
`;
}

/**
 * Main bundle func
 */
export async function bundle(appDir, outputDir) {
  console.log("🔍 Finding entry point...");
  const entryPoint = await findEntryPoint(appDir);
  console.log(`   Entry: ${path.relative(appDir, entryPoint)}`);

  console.log("📂 Collecting static assets...");
  const assets = await collectStaticAssets(appDir);
  console.log(`   Found ${assets.size} files`);

  const outputPath = path.join(outputDir, "bundle.js");
  await fs.mkdir(outputDir, { recursive: true });

  console.log("🔨 Bundling with esbuild...");
  
  const vfsCode = generateVFSCode(assets);

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
import fs from "fs";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

${vfsCode}
      `.trim(),
    },
    plugins: [virtualFileSystemPlugin],
    minify: false,
    sourcemap: false,
    logLevel: "info",
  });

  console.log(`✅ Bundle created: ${outputPath}`);
  return outputPath;
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const appDir = process.argv[2];
  const outputDir = process.argv[3] || "./dist";

  if (!appDir) {
    console.error("Usage: node bundler/index.js <app-dir> [output-dir]");
    process.exit(1);
  }

  bundle(appDir, outputDir).catch((err) => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  });
}