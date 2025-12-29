#!/usr/bin/env node
import { createCipheriv, scryptSync, randomBytes } from 'crypto';
import { readFile, writeFile, readdir } from 'fs/promises';
import { join, relative } from 'path';
import { existsSync } from 'fs';

// CLI аргументы
const [appDir, outputPath, encryptionKey] = process.argv.slice(2);

if (!appDir || !outputPath || !encryptionKey) {
  console.error('Usage: node encrypt.js <app-dir> <output-path> <encryption-key>');
  process.exit(1);
}

console.log('🔐 Encrypting application...');
console.log('   App dir:', appDir);
console.log('   Output:', outputPath);

async function scanDir(dir, baseDir, files) {
  const entries = await readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    
    if (entry.isDirectory()) {
      await scanDir(fullPath, baseDir, files);
    } else {
      const content = await readFile(fullPath);
      const relativePath = relative(baseDir, fullPath).replace(/\\/g, '/');
      files.set(relativePath, content);
    }
  }
}

function encryptData(data, key) {
  const algorithm = 'aes-256-gcm';
  const iv = randomBytes(16);
  const keyBuffer = scryptSync(key, 'salt', 32);
  
  const cipher = createCipheriv(algorithm, keyBuffer, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(data),
    cipher.final()
  ]);
  
  const authTag = cipher.getAuthTag();
  
  return Buffer.concat([iv, authTag, encrypted]);
}

// Собираем файлы
const files = new Map();

const libDir = join(appDir, 'lib');
const nodeModulesDir = join(appDir, 'node_modules');
const packageJsonPath = join(appDir, 'package.json');

if (existsSync(libDir)) {
  await scanDir(libDir, appDir, files);
}

if (existsSync(nodeModulesDir)) {
  await scanDir(nodeModulesDir, appDir, files);
}

if (existsSync(packageJsonPath)) {
  const content = await readFile(packageJsonPath);
  files.set('package.json', content);
}

console.log(`   📦 Collected ${files.size} files`);

// Упаковываем в JSON
const manifest = {};
for (const [path, content] of files) {
  manifest[path] = content.toString('base64');
}

const manifestJson = JSON.stringify(manifest);

// Шифруем
const encrypted = encryptData(Buffer.from(manifestJson), encryptionKey);

await writeFile(outputPath, encrypted);

console.log(`   ✅ Encrypted: ${(encrypted.length / 1024 / 1024).toFixed(1)} MB`);
