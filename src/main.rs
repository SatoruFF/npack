use clap::Parser;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Parser)]
#[command(name = "npack")]
#[command(version = "0.1.0")]
#[command(about = "Package Node.js apps into standalone executables", long_about = None)]
struct Args {
    /// Path to app folder or Git repository URL
    input: String,

    /// Target platform(s): host, all, linux, macos, windows
    #[arg(long, default_value = "host")]
    platform: String,

    /// Output directory
    #[arg(long, short, default_value = "./dist")]
    output: PathBuf,

    /// Skip bundling step (use existing bundle)
    #[arg(long)]
    skip_bundle: bool,

    /// Node.js version to use (18, 20, 22, 24)
    #[arg(long, default_value = "20")]
    node_version: String,
}

#[derive(Serialize, Deserialize)]
struct SEAConfig {
    main: String,
    output: String,
    #[serde(rename = "disableExperimentalSEAWarning")]
    disable_experimental_sea_warning: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // println!("{:?}", std::env::var("PATH"));

    let args = Args::parse();

    println!("📦 npack v0.1.0");
    println!();

    // Создаем output директорию
    fs::create_dir_all(&args.output)?;

    // Определяем, это Git URL или локальный путь
    let app_path = if args.input.starts_with("http") || args.input.starts_with("git@") {
        println!("🔄 Cloning repository...");
        clone_repository(&args.input, &args.output)?
    } else {
        PathBuf::from(&args.input)
    };

    println!("   App: {:?}", app_path);
    println!("   Platform: {}", args.platform);
    println!("   Node version: {}", args.node_version);
    println!();

    // Шаг 1: Установка зависимостей
    if !args.skip_bundle {
        println!("📥 Installing dependencies...");
        install_dependencies(&app_path)?;
    }

    // Шаг 2: Bundling с esbuild
    let bundle_path = if !args.skip_bundle {
        println!("\n🔨 Bundling with esbuild...");
        bundle_app(&app_path, &args.output)?
    } else {
        println!("⏭️  Skipping bundle step");
        args.output.join("bundle.js")
    };

    // Шаг 3: Создание Node.js SEA
    println!("\n📦 Creating Node.js SEA...");
    let sea_blob = create_sea(&bundle_path, &args.output)?;

    // Шаг 4: Создание platform executables
    println!("\n🎯 Creating platform executables...");
    create_executables(&args.platform, &sea_blob, &args.output, &args.node_version)?;

    println!("\n✅ Done! Executables:");
    list_executables(&args.output)?;

    Ok(())
}

/// Клонирует Git репозиторий
fn clone_repository(url: &str, output: &PathBuf) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let clone_dir = output.join("temp_clone");

    // Удаляем старую директорию если существует
    if clone_dir.exists() {
        fs::remove_dir_all(&clone_dir)?;
    }

    let status = Command::new("git")
        .arg("clone")
        .arg("--depth")
        .arg("1")
        .arg(url)
        .arg(&clone_dir)
        .status()?;

    if !status.success() {
        return Err("Git clone failed".into());
    }

    println!("   ✓ Cloned to {:?}", clone_dir);
    Ok(clone_dir)
}

/// Устанавливает npm зависимости
fn install_dependencies(app_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let package_json = app_path.join("package.json");
    
    if !package_json.exists() {
        println!("   No package.json found, skipping npm install");
        return Ok(());
    }

    let status = Command::new("npm")
        .arg("install")
        .arg("--production")
        .current_dir(app_path)
        .status()?;

    if !status.success() {
        return Err("npm install failed".into());
    }

    println!("   ✓ Dependencies installed");
    Ok(())
}

/// Запускает Node.js bundler
fn bundle_app(app_path: &PathBuf, output: &PathBuf) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let bundler_path = get_bundler_path()?;

    let status = Command::new("node")
        .arg(&bundler_path)
        .arg(app_path)
        .arg(output)
        .status()?;

    if !status.success() {
        return Err("Bundling failed".into());
    }

    Ok(output.join("bundle.js"))
}

/// Создает Node.js Single Executable Application blob
fn create_sea(
    bundle_path: &PathBuf,
    output: &PathBuf,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let sea_config_path = output.join("sea-config.json");
    let sea_blob_path = output.join("sea-prep.blob");

    let config = SEAConfig {
        main: bundle_path.to_string_lossy().to_string(),
        output: sea_blob_path.to_string_lossy().to_string(),
        disable_experimental_sea_warning: true,
    };

    let config_json = serde_json::to_string_pretty(&config)?;
    fs::write(&sea_config_path, config_json)?;

    println!("   Config: {:?}", sea_config_path);

    let status = Command::new("node")
        .arg("--experimental-sea-config")
        .arg(&sea_config_path)
        .status()?;

    if !status.success() {
        return Err("SEA creation failed".into());
    }

    println!("   Blob: {:?}", sea_blob_path);
    Ok(sea_blob_path)
}

/// Создает executable файлы для указанных платформ
fn create_executables(
    platform: &str,
    sea_blob: &PathBuf,
    output: &PathBuf,
    node_version: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    match platform {
        "windows" => {
            build_for_platform("windows", sea_blob, output, node_version)?;
        }
        "macos" => {
            build_for_platform("macos", sea_blob, output, node_version)?;
        }
        "linux" => {
            build_for_platform("linux", sea_blob, output, node_version)?;
        }
        "host" => {
            let current = std::env::consts::OS;
            build_for_platform(current, sea_blob, output, node_version)?;
        }
        "all" => {
            build_for_platform("linux", sea_blob, output, node_version)?;
            build_for_platform("macos", sea_blob, output, node_version)?;
            build_for_platform("windows", sea_blob, output, node_version)?;
        }
        p => build_for_platform(p, sea_blob, output, node_version)?,
    }
    Ok(())
}

/// Создает executable файл для конкретной платформы
fn build_for_platform(
    platform: &str,
    sea_blob: &PathBuf,
    output: &PathBuf,
    node_version: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("   Building for {}...", platform);

    let (output_name, is_windows) = match platform {
        "linux" => ("app-linux", false),
        "macos" => ("app-macos", false),
        "windows" => ("app-windows.exe", true),
        _ => return Err(format!("Unknown platform: {}", platform).into()),
    };

    // Копируем Node.js binary
    let exe_path = output.join(output_name);
    copy_node_binary(&exe_path, node_version)?;

    // На Unix делаем executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&exe_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&exe_path, perms)?;
    }

    // Инжектим SEA blob в binary
    inject_sea_blob(&exe_path, sea_blob, platform)?;

    println!("      ✓ {}", output_name);
    Ok(())
}

/// Копирует Node.js binary
fn copy_node_binary(dest: &PathBuf, _node_version: &str) -> Result<(), Box<dyn std::error::Error>> {
    // Получаем путь к текущему Node.js
    let output = Command::new("which").arg("node").output()?;

    if !output.status.success() {
        return Err("Cannot find node binary. Is Node.js installed?".into());
    }

    let node_path = String::from_utf8(output.stdout)?.trim().to_string();
    fs::copy(&node_path, dest)?;

    Ok(())
}

/// Инжектит SEA blob в Node.js binary
fn inject_sea_blob(
    exe_path: &PathBuf,
    sea_blob: &PathBuf,
    platform: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    // Используем postject для всех платформ
    let mut cmd = Command::new("npx");
    cmd.arg("postject")
        .arg(exe_path)
        .arg("NODE_SEA_BLOB")
        .arg(sea_blob)
        .arg("--sentinel-fuse")
        .arg("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2");

    // Для macOS добавляем флаг для работы с Mach-O
    if platform == "macos" {
        cmd.arg("--macho-segment-name").arg("NODE_SEA");
    }

    let status = cmd.status()?;

    if !status.success() {
        return Err("Failed to inject SEA blob".into());
    }

    // Для macOS удаляем подпись
    if platform == "macos" {
        Command::new("codesign")
            .arg("--remove-signature")
            .arg(exe_path)
            .output()?;
    }

    Ok(())
}

/// Находит путь к bundler скрипту
fn get_bundler_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Ищем относительно исполняемого файла
    let exe_dir = std::env::current_exe()?
        .parent()
        .ok_or("Cannot get exe dir")?
        .to_path_buf();

    let bundler = exe_dir.join("../bundler/index.js");
    if bundler.exists() {
        return Ok(bundler);
    }

    // Fallback на текущую директорию
    let bundler = PathBuf::from("bundler/index.js");
    if bundler.exists() {
        return Ok(bundler);
    }

    Err("Cannot find bundler/index.js. Make sure it's in the bundler/ directory.".into())
}

/// Выводит список созданных executables
fn list_executables(output: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let entries = fs::read_dir(output)?;

    for entry in entries {
        let entry = entry?;
        let path = entry.path();

        if let Some(name) = path.file_name() {
            let name_str = name.to_string_lossy();
            if name_str.starts_with("app-") {
                let metadata = fs::metadata(&path)?;
                let size_kb = metadata.len() / 1024;
                println!("   📄 {} ({} KB)", name_str, size_kb);
            }
        }
    }

    Ok(())
}