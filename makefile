APP_NAME := npack
TARGET := target/release/$(APP_NAME)

.PHONY: setup dev build release install clean test

# Установка зависимостей
setup:
	@echo "📦 Installing dependencies..."
	cargo build
	cd bundler && npm install
	@echo "✅ Setup complete!"

# Разработка
dev:
	@echo "🔧 Running in development mode..."
	cargo run -- ./example --platform host

# Тестовая сборка
test-local:
	@echo "🧪 Testing local project..."
	cargo run -- ./example --platform all --output ./test-dist

# Тестовая сборка из Git
test-git:
	@echo "🧪 Testing Git repository..."
	cargo run -- https://github.com/user/repo.git --platform all --output ./test-dist

# Сборка debug
build:
	@echo "🔨 Building debug..."
	cargo build

# Сборка release
release:
	@echo "🚀 Building release..."
	cargo build --release
	@echo "✅ Binary: $(TARGET)"

# Установка в систему
install: release
	@echo "📥 Installing to /usr/local/bin..."
	sudo cp $(TARGET) /usr/local/bin/$(APP_NAME)
	@echo "✅ Installed! Run 'npack --help'"

# Очистка
clean:
	@echo "🧹 Cleaning..."
	cargo clean
	rm -rf dist test-dist temp_clone
	rm -rf example/node_modules

# Показать справку
help:
	@echo "Available commands:"
	@echo "  make setup      - Install all dependencies"
	@echo "  make dev        - Run in development mode"
	@echo "  make build      - Build debug version"
	@echo "  make release    - Build release version"
	@echo "  make install    - Install to system"
	@echo "  make test-local - Test with local project"
	@echo "  make test-git   - Test with Git repository"
	@echo "  make clean      - Clean build artifacts"