# npack

**Cross-platform CLI tool для упаковки Node.js приложений в standalone executables**

Решает проблемы с `path.join(__dirname, ...)`, автоматически включает статические файлы и миграции, работает с Node.js 18+.

## ✨ Возможности

- ✅ **Автоматическое решение проблем с `__dirname`** - работает в ESM и CJS
- ✅ **Автоматический сбор статических файлов** - migrations, config, templates, data
- ✅ **Поддержка Git репозиториев** - клонирование и сборка напрямую из GitHub
- ✅ **Мультиплатформенная сборка** - Linux, macOS, Windows одной командой
- ✅ **Node.js 18, 20, 22, 24+** - работает с современными версиями
- ✅ **Virtual File System** - файлы встраиваются в бинарник
- ✅ **Нет конфигурации** - zero-config, работает из коробки

## 🚀 Быстрый старт

### Установка

```bash
# Клонируйте репозиторий
git clone https://github.com/yourusername/npack.git
cd npack

# Установите зависимости
make setup

# Соберите release версию
make release

# (Опционально) Установите в систему
make install
```

### Использование

```bash
# Упаковать локальное приложение для текущей платформы
npack ./my-app

# Упаковать для всех платформ
npack ./my-app --platform all

# Упаковать из Git репозитория
npack https://github.com/user/repo.git --platform all

# Указать output директорию
npack ./my-app --platform all --output ./builds
```

## 📋 Требования

- **Rust** 1.70+ (для сборки npack)
- **Node.js** 18+ (для работы bundler)
- **npm** или **yarn**
- **Git** (для клонирования репозиториев)
- **postject** (устанавливается автоматически через npx)

## 🎯 Как это работает

### 1. Анализ проекта

npack автоматически находит:

- Entry point из `package.json` (bin, main)
- Все статические директории: `config/`, `migrations/`, `templates/`, `public/`, `data/` и т.д.
- Файлы с нестандартными расширениями: `.sql`, `.json`, `.yaml`, `.xml`, `.pem`

### 2. Bundling

- Использует **esbuild** для быстрого бандлинга
- Создает **Virtual File System (VFS)** со всеми статическими файлами
- Перехватывает `fs.readFileSync`, `fs.readFile`, `fs.existsSync`, `fs.readdirSync`
- Автоматически решает проблемы с `__dirname` в ESM

### 3. SEA Creation

- Создает Node.js Single Executable Application blob
- Использует официальный механизм Node.js SEA (18.16+)

### 4. Platform Executables

- Копирует Node.js binary для нужной платформы
- Инжектит SEA blob с помощью **postject**
- Создает готовые к распространению executables

## 📂 Структура проекта

```
npack/
├── src/
│   └── main.rs              # Rust CLI оркестратор
├── bundler/
│   ├── index.js             # Node.js bundler с VFS
│   └── package.json
├── example/                 # Тестовое приложение
│   ├── index.js
│   ├── config/
│   ├── migrations/
│   └── templates/
├── Cargo.toml
├── Makefile
└── README.md
```

## 🧪 Тестирование

```bash
# Тест с локальным проектом
make test-local

# Тест с Git репозиторием
make test-git

# Запуск созданного executable
./dist/app-linux     # на Linux
./dist/app-macos     # на macOS
./dist/app-windows.exe  # на Windows
```

## 🔧 Примеры

### Базовый Express API

```javascript
// index.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Это работает! Конфиг будет в VFS
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "./config/app.json"), "utf8"));

app.get("/", (req, res) => {
  res.json({ message: "Hello from packaged app!", config });
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
```

Упаковка:

```bash
npack ./my-api --platform all
# Получите: app-linux, app-macos, app-windows.exe
```

### CLI инструмент с миграциями

```javascript
// cli.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Загрузка всех миграций
const migrationsDir = path.join(__dirname, "./migrations");
const migrations = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => ({
    name: f,
    sql: fs.readFileSync(path.join(migrationsDir, f), "utf8"),
  }));

console.log(`Found ${migrations.length} migrations`);
migrations.forEach((m) => console.log(`- ${m.name}`));
```

## 🐛 Решение проблем

### "Cannot find bundler/index.js"

```bash
# Убедитесь, что вы установили зависимости
cd bundler && npm install
```

### "postject not found"

postject устанавливается автоматически через `npx`, но если проблемы:

```bash
npm install -g postject
```

### Файлы не находятся в runtime

Проверьте, что:

1. Файлы находятся в стандартных директориях (`config/`, `migrations/`, etc.)
2. Используете `path.join(__dirname, './path')` для путей
3. Файлы существуют до сборки

## 📚 API Reference

### CLI Options

```
npack <input> [OPTIONS]

Arguments:
  <input>              Path to app or Git URL

Options:
  --platform <PLATFORM>   Target: host, all, linux, macos, windows [default: host]
  -o, --output <DIR>      Output directory [default: ./dist]
  --skip-bundle           Skip bundling (use existing bundle.js)
  --node-version <VER>    Node version: 18, 20, 22, 24 [default: 20]
  -h, --help              Print help
```

### Makefile Commands

```bash
make setup       # Install dependencies
make dev         # Run in dev mode
make build       # Build debug version
make release     # Build release version
make install     # Install to /usr/local/bin
make clean       # Clean artifacts
make test-local  # Test with local project
make test-git    # Test with Git repo
```

## 🎨 Архитектурные решения

### Почему Rust + esbuild + Node.js SEA?

- **Rust**: надежная кросс-платформенная оркестрация
- **esbuild**: самый быстрый JavaScript bundler
- **Node.js SEA**: официальный механизм от Node.js, стабильный и поддерживаемый

### Почему не pkg/vercel?

- Не поддерживает Node.js 18+
- Сложная кодовая база
- Мало контроля над процессом

### Virtual File System

VFS встраивает файлы как Base64 и перехватывает fs методы на уровне runtime. Это прозрачно для приложения.

## 🗺️ Roadmap

- [x] Базовая функциональность
- [x] VFS с автоматическим сбором файлов
- [x] Git repository support
- [x] Multi-platform builds
- [ ] Windows code signing
- [ ] macOS code signing
- [ ] Сжатие executables (UPX)
- [ ] Asset encryption
- [ ] Custom Node.js builds
- [ ] Plugin system

## 📄 Лицензия

MIT

## 🤝 Contributing

Pull requests приветствуются! Для крупных изменений сначала откройте issue.

## 💬 Поддержка

- Issues: [GitHub Issues](https://github.com/yourusername/npack/issues)
- Discussions: [GitHub Discussions](https://github.com/yourusername/npack/discussions)

---

**Made with ❤️ for the Node.js community**
