mod config;
use clap::Parser;
use config::NpackConfig;
use serde::{Deserialize, Serialize};
use std::fs::{self};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio::process::Command as TokioCommand;

#[derive(Parser, Debug, Clone)]
#[command(name = "npack")]
#[command(version = "0.0.1")]
#[command(about = "Package Node.js apps into standalone executables", long_about = None)]
pub struct Args {
    /// Git repository URL or local directory (optional if using config)
    pub source: Option<String>,

    /// Use config file (looks for npack.config.json in current directory)
    #[arg(long)]
    pub config: bool,

    /// Path to custom config file
    #[arg(long, value_name = "FILE")]
    pub config_file: Option<PathBuf>,

    /// Entry point JavaScript file
    #[arg(long)]
    pub entry: Option<String>,

    /// Target platform
    #[arg(long)]
    pub platform: Option<String>,

    /// Node.js version
    #[arg(long)]
    pub node_version: Option<String>,

    /// Output directory
    #[arg(long)]
    pub output: Option<PathBuf>,

    /// Run postinstall script
    #[arg(long)]
    pub run_postinstall: bool,

    /// Database connection string
    #[arg(long)]
    pub db_connection: Option<String>,

    /// S3 Key
    #[arg(long)]
    pub s3_key: Option<String>,

    /// S3 Secret
    #[arg(long)]
    pub s3_secret: Option<String>,
}

impl Args {
    /// Merge with environment variables
    pub fn merge_with_env(&mut self) {
        if self.db_connection.is_none() {
            self.db_connection = std::env::var("DB_CONNECTION_STRING").ok();
        }
        if self.s3_key.is_none() {
            self.s3_key = std::env::var("PACKAGES_STORAGE_S3_KEY").ok();
        }
        if self.s3_secret.is_none() {
            self.s3_secret = std::env::var("PACKAGES_STORAGE_S3_SECRET").ok();
        }
    }
}

#[derive(Serialize, Deserialize)]
struct SEAConfig {
    main: String,
    output: String,
    #[serde(rename = "disableExperimentalSEAWarning")]
    disable_experimental_sea_warning: bool,
}

// Константа для sentinel fuse (из документации Node.js SEA)
const NODE_SEA_FUSE: &str = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = Args::parse();

    // ✅ Сначала читаем из ENV
    args.merge_with_env();

    // Load config if requested
    let mut config = if args.config {
        NpackConfig::find_in_cwd().unwrap_or_default()
    } else if let Some(config_path) = &args.config_file {
        NpackConfig::from_file(config_path)?
    } else {
        NpackConfig::default()
    };

    // Merge CLI args (override config)
    config.merge_with_args(&args);

    // Validate config
    config.validate()?;

    println!("📦 npack v{}\n", env!("CARGO_PKG_VERSION"));

    // Применяем ENV из конфига
    let env_vars = config.get_env_vars();
    for (key, value) in &env_vars {
        std::env::set_var(key, value);
    }

    if let Err(e) = run(config).await {
        eprintln!("❌ Error: {}", e);
        std::process::exit(1);
    }
    Ok(())
}

async fn run(config: NpackConfig) -> Result<(), Box<dyn std::error::Error>> {
    let source = config.get_source()?;
    let output = PathBuf::from(config.get_output());
    let platform = config.get_platform();
    let node_version = config.get_node_version();

    // Создаем output директорию СРАЗУ
    fs::create_dir_all(&output)
        .map_err(|e| format!("Failed to create output directory {:?}: {}", output, e))?;

    let target_platform = if platform == "host" {
        std::env::consts::OS
    } else {
        platform.as_str()
    };

    let (node_arch, _) = match target_platform {
        "linux" => ("linux-x64", "app-linux"),
        "macos" | "darwin" => ("darwin-x64", "app-macos"),
        "windows" => ("win-x64", "app-windows.exe"),
        _ => return Err(format!("Unsupported platform: {}", target_platform).into()),
    };

    // Скачиваем node binary
    let node_binary_path = output.join("node-binary");
    download_node_binary(&node_version, node_arch, &node_binary_path).await?;

    // Делаем исполняемым (Unix)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&node_binary_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&node_binary_path, perms)?;
    }

    let app_path = if source.starts_with("http") || source.starts_with("git@") {
        println!("🔄 Cloning repository...");
        clone_repository(&source, &output).map_err(|e| format!("Git clone failed: {}", e))?
    } else {
        PathBuf::from(&source)
    };

    println!("   App: {:?}", app_path);
    println!("   Platform: {}", platform);
    println!("   Node version: {}\n", node_version);

    println!("📥 Installing dependencies...");
    install_dependencies(&app_path, &config)
        .map_err(|e| format!("Installing dependencies failed: {}", e))?;

    println!("\n🔨 Bundling with ESBUILD...");
    let bundle_path = bundle_app(&app_path, &output, config.get_entry().as_deref())
        .map_err(|e| format!("Bundling failed: {}", e))?;

    println!("\n📦 Creating Node.js SEA...");
    let sea_blob = create_sea(&bundle_path, &output, &node_binary_path)
        .map_err(|e| format!("SEA creation failed: {}", e))?;

    println!("\n🎯 Creating platform executables...");
    create_executables(
        &platform,
        &sea_blob,
        &output,
        &node_version,
        &node_binary_path,
    )
    .await
    .map_err(|e| format!("Creating executables failed: {}", e))?;

    println!("\n✅ Done! Executables:");
    list_executables(&output).map_err(|e| format!("Listing executables failed: {}", e))?;

    Ok(())
}

fn cleanup_temp_files(output: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let files_to_remove = [
        "node-binary",
        "sea-config.json",
        "sea-prep.blob",
        "bundle.js",
    ];

    for file in &files_to_remove {
        let path = output.join(file);
        if path.exists() {
            fs::remove_file(&path)?;
        }
    }

    // Удаляем temp_clone если есть
    let temp_clone = output.join("temp_clone");
    if temp_clone.exists() {
        fs::remove_dir_all(&temp_clone)?;
    }

    Ok(())
}

fn clone_repository(url: &str, output: &PathBuf) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let clone_dir = output.join("temp_clone");
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

fn patch_npm_postinstall(app_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let postinstall_path = app_path.join("npmPostinstall.js");

    if !postinstall_path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&postinstall_path)?;

    // ✅ Заменяем spawn.sync("npm", ["run", "prepack"]) на npx babel
    let patched = content
        .replace(
            r#"const result = spawn.sync("npm", ["run", "prepack"]);"#,
            r#"const result = spawn.sync("npx", ["babel", "-d", "lib/", "src/", "--source-maps", "inline"]);"#
        )
        .replace(
            r#"spawn.sync("node", ["postinstall"])"#,
            r#"spawn.sync("node", ["lib/postinstall/index.js"])"#
        );

    fs::write(&postinstall_path, patched)?;
    println!("   ✓ Patched npmPostinstall.js");

    Ok(())
}

fn install_dependencies(app_path: &Path, config: &NpackConfig) -> Result<(), Box<dyn std::error::Error>> {
    if !app_path.join("package.json").exists() {
        println!("   No package.json found, skipping npm install");
        return Ok(());
    }

    let npm_cmd = if cfg!(windows) { "npm.cmd" } else { "npm" };
    
    // ✅ Читаем package.json чтобы понять что там есть
    let package_json_path = app_path.join("package.json");
    let package_content = fs::read_to_string(&package_json_path)?;
    let package: serde_json::Value = serde_json::from_str(&package_content)?;
    
    // Проверяем есть ли babel в devDependencies
    let has_babel = package
        .get("devDependencies")
        .and_then(|deps| deps.as_object())
        .map(|deps| {
            deps.contains_key("@babel/core") || 
            deps.contains_key("@babel/cli") ||
            deps.contains_key("babel-cli")
        })
        .unwrap_or(false);

    // Проверяем есть ли compile script
    let has_compile_script = package
        .get("scripts")
        .and_then(|scripts| scripts.as_object())
        .and_then(|scripts| scripts.get("compile"))
        .is_some();

    // ✅ Устанавливаем зависимости (с dev если есть babel)
    let mut install_cmd = Command::new(npm_cmd);
    install_cmd
        .arg("install")
        .arg("--ignore-scripts")
        .current_dir(app_path);

    if !has_babel {
        install_cmd.arg("--omit=dev");
    }

    let status = install_cmd.status()?;

    if !status.success() {
        return Err("npm install failed".into());
    }

    println!("   ✓ Dependencies installed");

    // ✅ Запускаем babel compile только если есть скрипт
    if has_compile_script {
        println!("\n🔨 Compiling with Babel...");
        let compile = Command::new(npm_cmd)
            .current_dir(app_path)
            .args(&["run", "compile"])
            .status();

        match compile {
            Ok(status) if status.success() => {
                println!("   ✓ Babel compilation completed");
            }
            Ok(status) => {
                eprintln!("   ⚠️ Babel compilation failed with code: {:?}", status.code());
                return Err(format!("Babel compilation failed with code: {:?}", status.code()).into());
            }
            Err(e) => {
                eprintln!("   ⚠️ Compile script error: {}", e);
                return Err(format!("Compile script error: {}", e).into());
            }
        }
    }

    // ✅ Запускаем postinstall если указано в конфиге
    if config.should_run_postinstall() {
        println!("\n🔄 Running postinstall...");

        // ✅ УСТАНАВЛИВАЕМ ENV ПЕРЕМЕННЫЕ из конфига
        let env_vars = config.get_env_vars();
        
        let mut postinstall_cmd = Command::new(npm_cmd);
        postinstall_cmd
            .current_dir(app_path)
            .args(&["run", "postinstall"]);

        // ✅ Добавляем все ENV переменные в процесс
        for (key, value) in &env_vars {
            postinstall_cmd.env(key, value);
            println!("   ENV: {} = {}", key, if key.contains("SECRET") { "***" } else { value });
        }

        let postinstall = postinstall_cmd.status();

        match postinstall {
            Ok(status) if status.success() => {
                println!("   ✓ Postinstall completed");
            }
            Ok(status) => {
                eprintln!("   ⚠️ Postinstall failed with code: {:?}", status.code());
                // НЕ фейлим весь билд, продолжаем
            }
            Err(e) => {
                eprintln!("   ⚠️ Postinstall error: {}", e);
            }
        }
    }

    Ok(())
}

fn bundle_app(
    app_path: &Path,
    output: &Path,
    entry: Option<&str>,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let bundler_path = get_bundler_path()?;

    let mut cmd = Command::new("node");
    cmd.arg(&bundler_path).arg(app_path).arg(output);

    if let Some(entry_point) = entry {
        cmd.arg("--entry").arg(entry_point);
    }

    // ✅ Используем .output() чтобы захватить stdout/stderr
    let output_result = cmd.output()?;

    // ✅ Выводим stdout (включая ошибки от bundler)
    let stdout = String::from_utf8_lossy(&output_result.stdout);
    if !stdout.is_empty() {
        print!("{}", stdout);
    }

    // ✅ Выводим stderr
    let stderr = String::from_utf8_lossy(&output_result.stderr);
    if !stderr.is_empty() {
        eprint!("{}", stderr);
    }

    if !output_result.status.success() {
        return Err(format!("Bundling failed with exit code: {}", output_result.status).into());
    }

    let bundle_path = output.join("bundle.js");

    if !bundle_path.exists() {
        return Err(format!(
            "Bundler completed but bundle.js not found at {:?}",
            bundle_path
        )
        .into());
    }

    Ok(bundle_path)
}

fn create_sea(
    bundle_path: &Path,
    output: &Path,
    node_binary: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let sea_config_path = output.join("sea-config.json");
    let sea_blob_path = output.join("sea-prep.blob");

    let config = SEAConfig {
        main: bundle_path.to_string_lossy().into_owned(),
        output: sea_blob_path.to_string_lossy().into_owned(),
        disable_experimental_sea_warning: true,
    };

    fs::write(&sea_config_path, serde_json::to_string_pretty(&config)?)?;

    let output = Command::new(node_binary)
        .arg("--experimental-sea-config")
        .arg(&sea_config_path)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "SEA creation failed.\nstdout: {}\nstderr: {}",
            stdout, stderr
        )
        .into());
    }

    Ok(sea_blob_path)
}

async fn create_executables(
    platform: &str,
    sea_blob: &Path,
    output: &Path,
    node_version: &str,
    node_binary_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let platforms = match platform {
        "all" => vec!["linux", "macos", "windows"],
        "host" => {
            let os = std::env::consts::OS;
            vec![if os == "darwin" { "macos" } else { os }]
        }
        _ => vec![platform],
    };

    for p in platforms {
        build_for_platform(p, sea_blob, output, node_version, node_binary_path).await?;
    }
    Ok(())
}

async fn build_for_platform(
    platform: &str,
    sea_blob: &Path,
    output: &Path,
    node_version: &str,
    _node_binary_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("   Building for {}...", platform);

    let (output_name, node_arch) = match platform {
        "linux" => ("app-linux", "linux-x64"),
        "macos" | "darwin" => ("app-macos", "darwin-x64"),
        "windows" => ("app-windows.exe", "win-x64"),
        _ => return Err(format!("Unsupported platform: {}", platform).into()),
    };

    let exe_path = output.join(output_name);

    // Скачиваем Node.js бинарник для целевой платформы
    download_node_binary(node_version, node_arch, &exe_path).await?;

    // Делаем исполняемым (Unix)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&exe_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&exe_path, perms)?;
    }

    // Для macOS удаляем подпись ПЕРЕД инжектом
    if platform == "macos" || platform == "darwin" {
        let _ = Command::new("codesign")
            .arg("--remove-signature")
            .arg(&exe_path)
            .output();
    }

    // Инжектим SEA blob
    inject_sea_blob(&exe_path, sea_blob, platform).await?;

    // Для macOS переподписываем после инжекта
    if platform == "macos" || platform == "darwin" {
        let _ = Command::new("codesign")
            .arg("--sign")
            .arg("-")
            .arg(&exe_path)
            .output();
    }

    println!("      ✓ {}", output_name);
    Ok(())
}

async fn inject_sea_blob(
    exe_path: &Path,
    sea_blob: &Path,
    platform: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    // ✅ На Windows используем npx.cmd
    let npx_cmd = if cfg!(windows) { "npx.cmd" } else { "npx" };

    let mut cmd = TokioCommand::new(npx_cmd);
    cmd.arg("postject")
        .arg(exe_path)
        .arg("NODE_SEA_BLOB")
        .arg(sea_blob)
        .arg("--sentinel-fuse")
        .arg(NODE_SEA_FUSE);

    if platform == "macos" || platform == "darwin" {
        cmd.arg("--macho-segment-name").arg("NODE_SEA");
    }

    println!("   Running: {} postject {:?}", npx_cmd, exe_path);

    let output = cmd.output().await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Failed to inject SEA blob.\nstdout: {}\nstderr: {}",
            stdout, stderr
        )
        .into());
    }

    Ok(())
}

async fn download_node_binary(
    version: &str,
    arch: &str,
    dest: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    // Создаем родительскую директорию если не существует
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }

    // Получаем latest patch версию
    let full_version = resolve_node_version(version).await?;

    let is_windows = arch.starts_with("win");

    let archive_name = if is_windows {
        format!("node-v{}-{}.zip", full_version, arch)
    } else {
        format!("node-v{}-{}.tar.gz", full_version, arch)
    };

    let url = format!("https://nodejs.org/dist/v{}/{}", full_version, archive_name);
    println!("   Downloading Node.js {} from {}", full_version, url);

    let response = reqwest::get(&url).await?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download Node.js from {}: {}",
            url,
            response.status()
        )
        .into());
    }

    let body = response.bytes().await?;

    let temp_dir = tempfile::tempdir()?;
    let archive_path = temp_dir.path().join(&archive_name);
    fs::write(&archive_path, &body)?;

    // Путь к node бинарнику внутри архива
    let folder_name = format!("node-v{}-{}", full_version, arch);

    if is_windows {
        extract_node_from_zip(&archive_path, &folder_name, dest)?;
    } else {
        extract_node_from_tar_gz(&archive_path, &folder_name, dest)?;
    }

    println!("   ✓ Node.js binary saved to: {:?}", dest);
    Ok(())
}

fn extract_node_from_zip(
    archive_path: &Path,
    folder_name: &str,
    dest: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let zip_file = fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(zip_file)?;

    // В Windows архиве: node-v20.19.6-win-x64/node.exe
    let node_entry_name = format!("{}/node.exe", folder_name);

    let mut node_file = archive
        .by_name(&node_entry_name)
        .map_err(|e| format!("Cannot find {} in archive: {}", node_entry_name, e))?;

    let mut contents = Vec::new();
    node_file.read_to_end(&mut contents)?;
    fs::write(dest, contents)?;

    Ok(())
}

fn extract_node_from_tar_gz(
    archive_path: &Path,
    folder_name: &str,
    dest: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let tar_gz = fs::File::open(archive_path)?;
    let tar = flate2::read::GzDecoder::new(tar_gz);
    let mut archive = tar::Archive::new(tar);

    // В Unix архиве: node-v20.19.6-darwin-x64/bin/node
    let expected_path = format!("{}/bin/node", folder_name);

    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;
        let path_str = path.to_string_lossy();

        if path_str == expected_path || path_str.ends_with("/bin/node") {
            let mut contents = Vec::new();
            entry.read_to_end(&mut contents)?;
            fs::write(dest, contents)?;
            return Ok(());
        }
    }

    Err(format!("Cannot find {} in archive", expected_path).into())
}

async fn resolve_node_version(major: &str) -> Result<String, Box<dyn std::error::Error>> {
    // Если уже полная версия (например "20.19.6"), вернуть как есть
    if major.matches('.').count() >= 2 {
        return Ok(major.to_string());
    }

    let url = "https://nodejs.org/dist/index.json";
    let client = reqwest::Client::new();
    let versions: Vec<NodeVersion> = client.get(url).send().await?.json().await?;

    let major_prefix = format!("{}.", major);

    for v in versions {
        let version_num = v.version.strip_prefix('v').unwrap_or(&v.version);
        if version_num.starts_with(&major_prefix) || version_num == major {
            return Ok(version_num.to_string());
        }
    }

    Err(format!("No Node.js version found for major version: {}", major).into())
}

#[derive(serde::Deserialize)]
struct NodeVersion {
    version: String,
}

fn get_bundler_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Относительно Cargo.toml (корень проекта) - работает в dev mode
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let bundler = PathBuf::from(manifest_dir).join("bundler/index.js");

    if bundler.exists() {
        return Ok(bundler);
    }

    // Относительно исполняемого файла (для release)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let bundler = exe_dir.join("../bundler/index.js");
            if bundler.exists() {
                // ✅ На Unix используем canonicalize (нормализует симлинки)
                #[cfg(unix)]
                if let Ok(canonical) = bundler.canonicalize() {
                    return Ok(canonical);
                }

                // ✅ На Windows возвращаем как есть (canonicalize ломает)
                #[cfg(windows)]
                return Ok(bundler);
            }
        }
    }

    // Относительно текущей директории
    let paths_to_try = [
        PathBuf::from("bundler/index.js"),
        PathBuf::from("./bundler/index.js"),
    ];

    for path in &paths_to_try {
        if path.exists() {
            #[cfg(unix)]
            if let Ok(canonical) = path.canonicalize() {
                return Ok(canonical);
            }

            #[cfg(windows)]
            return Ok(path.to_path_buf());
        }
    }

    Err("Cannot find bundler/index.js. Make sure it's in the bundler/ directory.".into())
}

fn list_executables(output: &Path) -> Result<(), Box<dyn std::error::Error>> {
    for entry in fs::read_dir(output)? {
        let entry = entry?;
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with("app-") {
                let size_mb = fs::metadata(&path)?.len() as f64 / 1024.0 / 1024.0;
                println!("   📄 {} ({:.1} MB)", name, size_mb);
            }
        }
    }
    Ok(())
}
