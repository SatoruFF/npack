import { rspack } from '@rspack/core';
import { mkdir, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

export async function bundle(appDir, outputDir, customEntry = null) {
  console.log("🔍 Finding entry point...");
  const entryPoint = await findEntryPoint(appDir, customEntry);
  console.log(`   Entry: ${path.relative(appDir, entryPoint)}`);

  const absoluteOutputDir = path.resolve(outputDir);
  const outputPath = path.join(absoluteOutputDir, "bundle.js");
  
  await mkdir(absoluteOutputDir, { recursive: true });

  console.log("🔨 Bundling with rspack...");

  const normalizedEntry = path.resolve(entryPoint).replace(/\\/g, "/");
  const migrationsDir = path.join(appDir, 'migrations');

  // ✅ СОБИРАЕМ МИГРАЦИИ
  let migrationFiles = [];
  let migrationContents = {};
  if (existsSync(migrationsDir)) {
    migrationFiles = await readdir(migrationsDir);
    migrationFiles = migrationFiles.filter(f => f.endsWith('.js')).sort();
    console.log(`   Found ${migrationFiles.length} migrations`);

    for (const file of migrationFiles) {
      const filePath = path.join(migrationsDir, file);
      migrationContents[file] = await readFile(filePath, 'utf-8');
    }
  }

  const rspackConfig = {
    mode: "production",
    target: "node",
    entry: {
      main: normalizedEntry
    },
    output: {
      path: absoluteOutputDir,
      filename: "bundle.js",
      libraryTarget: "commonjs2",
    },
    resolve: {
      extensions: [".js", ".json", ".node"],
      fallback: {
        'tedious': false,
        'mysql': false,
        'mysql2': false,
        'oracledb': false,
        'pg-query-stream': false,
        'cls-bluebird': false,
      },
    },
    externals: {
      'better-sqlite3': 'commonjs better-sqlite3',
      'sqlite3': 'commonjs sqlite3',
    },
    externalsPresets: {
      node: true,
    },
    optimization: {
      minimize: false,
    },
    plugins: [
      new rspack.IgnorePlugin({
        resourceRegExp: /^(tedious|mysql|mysql2|oracledb|pg-query-stream|cls-bluebird)$/,
      }),

      // ✅ ПРОСТОЙ ПАТЧ FS.READDIRSYNC + ДИНАМИЧЕСКИЙ REQUIRE
      new rspack.BannerPlugin({
        banner: `
          // ✅ NPACK MIGRATIONS - SEA COMPATIBLE
          (() => {
            const NPACK_MIGRATIONS = ${JSON.stringify(migrationContents)};
            const NPACK_MIGRATION_FILES = ${JSON.stringify(migrationFiles)};
            
            // ✅ ПАТЧ 1: fs.readdirSync('./migrations')
            const fs = require('fs');
            const originalReaddirSync = fs.readdirSync;
            fs.readdirSync = function(dir) {
              const dirStr = String(dir).replace(/\\\\g/, '/').toLowerCase();
              if (dirStr.includes('migrations')) {
                console.log('[NPACK] Virtual migrations FS:', NPACK_MIGRATION_FILES.length, 'files');
                return NPACK_MIGRATION_FILES;
              }
              return originalReaddirSync.apply(this, arguments);
            };
            
            // ✅ ПАТЧ 2: Динамический require('./migrations/XXX.js')
            const Module = require('module');
            const originalRequire = Module._load || Module.prototype.require;
            
            Module.prototype.require = function(request) {
              const filename = request.split('/').pop().split('\\\\').pop();
              if (NPACK_MIGRATION_FILES.includes(filename)) {
                console.log('[NPACK] Loading migration:', filename);
                return Function('module', 'exports', 'require', '__filename', '__dirname', 
                  NPACK_MIGRATIONS[filename]
                )( { exports: {} }, {}, this.require.bind(this), filename, './migrations/' + filename, './migrations');
              }
              return originalRequire.apply(this, arguments);
            };
          })();
        `,
        raw: true,
        entryOnly: true
      })
    ],
  };

  const compiler = rspack(rspackConfig);

  await new Promise((resolve, reject) => {
    compiler.run((err, stats) => {
      if (err) {
        console.error("❌ Rspack fatal error:", err);
        return reject(err);
      }

      if (stats.hasErrors()) {
        const info = stats.toJson();
        console.error("❌ Rspack compilation errors:");
        info.errors.forEach((error) => {
          console.error(error.message);
        });
        return reject(new Error("Rspack compilation failed"));
      }

      if (stats.hasWarnings()) {
        const info = stats.toJson();
        console.warn("⚠️ Rspack warnings:");
        info.warnings.forEach((warning) => {
          console.warn(warning.message);
        });
      }

      console.log("   ✓ Bundle created");
      resolve();
    });
  });

  return outputPath;
}

async function findEntryPoint(appDir, customEntry) {
  if (customEntry) {
    const customPath = path.resolve(appDir, customEntry);
    return customPath;
  }

  const possibleEntries = [
    "lib/postinstall/index.js",
    "lib/index.js",
    "index.js",
    "src/index.js",
  ];

  for (const entry of possibleEntries) {
    const fullPath = path.join(appDir, entry);
    try {
      await readFile(fullPath);
      return fullPath;
    } catch (e) {
      continue;
    }
  }

  throw new Error(`Cannot find entry point in ${appDir}`);
}

// CLI
const [appDir, outputDir, ...args] = process.argv.slice(2);

if (!appDir || !outputDir) {
  console.error("Usage: node bundler.js <app-dir> <output-dir> [--entry <entry-file>]");
  process.exit(1);
}

const entryIndex = args.indexOf("--entry");
const customEntry = entryIndex >= 0 ? args[entryIndex + 1] : null;

bundle(appDir, outputDir, customEntry)
  .then(() => {
    console.log("✅ Bundling complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Bundling failed:", err);
    process.exit(1);
  });
