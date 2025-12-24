import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🚀 Test Application Started!');
console.log('='.repeat(50));

// Тест 1: Чтение конфига
console.log('\n📋 Test 1: Reading config...');
try {
  const configPath = path.join(__dirname, './config/app.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  console.log('   ✓ Config loaded:', config);
} catch (e) {
  console.log('   ✗ Failed:', e.message);
}

// Тест 2: Чтение миграций
console.log('\n📂 Test 2: Reading migrations...');
try {
  const migrationsPath = path.join(__dirname, './migrations');
  const files = fs.readdirSync(migrationsPath);
  console.log(`   ✓ Found ${files.length} migration(s):`, files);
  
  // Читаем первую миграцию
  if (files.length > 0) {
    const firstMigration = fs.readFileSync(
      path.join(migrationsPath, files[0]),
      'utf8'
    );
    console.log('   ✓ First migration preview:', firstMigration.slice(0, 100) + '...');
  }
} catch (e) {
  console.log('   ✗ Failed:', e.message);
}

// Тест 3: Чтение шаблона
console.log('\n📄 Test 3: Reading template...');
try {
  const templatePath = path.join(__dirname, './templates/email.html');
  const template = fs.readFileSync(templatePath, 'utf8');
  console.log('   ✓ Template loaded, length:', template.length);
} catch (e) {
  console.log('   ✗ Failed:', e.message);
}

// Тест 4: Проверка существования файлов
console.log('\n🔍 Test 4: Checking file existence...');
const testPaths = [
  './config/app.json',
  './migrations/001_init.sql',
  './templates/email.html',
  './data/sample.txt'
];

for (const testPath of testPaths) {
  const fullPath = path.join(__dirname, testPath);
  const exists = fs.existsSync(fullPath);
  console.log(`   ${exists ? '✓' : '✗'} ${testPath}: ${exists ? 'exists' : 'not found'}`);
}

// Тест 5: Работа с данными
console.log('\n💾 Test 5: Reading data file...');
try {
  const dataPath = path.join(__dirname, './data/sample.txt');
  const data = fs.readFileSync(dataPath, 'utf8');
  console.log('   ✓ Data loaded:', data);
} catch (e) {
  console.log('   ✗ Failed:', e.message);
}

console.log('\n' + '='.repeat(50));
console.log('✅ All tests completed!');
console.log('\n💡 This app demonstrates:');
console.log('   - Reading config files with path.join(__dirname, ...)');
console.log('   - Scanning directories (migrations)');
console.log('   - Loading templates and static files');
console.log('   - Using fs.existsSync() for file checks');
console.log('\n📦 If you see all ✓ marks, npack works correctly!');