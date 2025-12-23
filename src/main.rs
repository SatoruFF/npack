use clap::Parser;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[derive(Parser)]
#[command(name = "npack")]
#[command(version = "0.1.0")]
#[command(about = "Package Node.js apps without pain", long_about = None)]
struct Args {
    /// Path to the app folder
    #[arg(long)]
    path: PathBuf,

    /// Target platform(s): host, all, linux, macos, windows
    #[arg(long, default_value = "host")]
    platform: String,

    /// Output directory
    #[arg(long, default_value = "./dist")]
    output: PathBuf,

    /// Entry point (default: auto-detect from package.json)
    #[arg(long)]
    entry: Option<String>,

    /// Skip bundling step (use existing bundle)
    #[arg(long)]
    skip_bundle: bool,
}

#[derive(Serialize, Deserialize)]
struct SEAConfig {
    main: String,
    output: String,
    #[serde(rename = "disableExperimentalSEAWarning")]
    disable_experimental_sea_warning: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    println!("📦 npack - Node.js packager");
    println!("   App: {:?}", args.path);
    println!("   Platform: {}", args.platform);
    println!();

    // Create output directory
    fs::create_dir_all(&args.output)?;

    let bundle_path = if !args.skip_bundle {
        // Step 1: Bundling with esbuild
        println!("🔨 Step 1: Bundling with esbuild...");
        bundle_app(&args.path, &args.output)?
    } else {
        println!("⏭️  Skipping bundle step");
        args.output.join("bundle.js")
    };

    // Step 2: Create Node.js SEA
    println!("\n📦 Step 2: Creating Node.js SEA...");
    let sea_blob = create_sea(&bundle_path, &args.output)?;

    // Step 3: Create Platform Executables
    println!("\n🎯 Step 3: Creating platform executables...");
    create_executables(&args.platform, &sea_blob, &args.output)?;

    println!("\n✅ Done! Executables are in {:?}", args.output);
    Ok(())
}

/// Run Node.js bundler
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

/// Create Node.js Single Executable Application blob
fn create_sea(
    bundle_path: &PathBuf,
    output: &PathBuf,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let sea_config_path = output.join("sea-config.json");
    let sea_blob_path = output.join("sea-prep.blob");

    // Create config for SEA
    let config = SEAConfig {
        main: bundle_path.to_string_lossy().to_string(),
        output: sea_blob_path.to_string_lossy().to_string(),
        disable_experimental_sea_warning: true,
    };

    let config_json = serde_json::to_string_pretty(&config)?;
    fs::write(&sea_config_path, config_json)?;

    println!("   Config: {:?}", sea_config_path);

    // Generate SEA blob
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

/// Create executable files for the specified platforms
fn create_executables(
    platform: &str,
    sea_blob: &PathBuf,
    output: &PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    match platform {
        "host" => {
            let current = std::env::consts::OS;
            build_for_platform(current, sea_blob, output)?;
        }
        "all" => {
            build_for_platform("linux", sea_blob, output)?;
            build_for_platform("macos", sea_blob, output)?;
            build_for_platform("windows", sea_blob, output)?;
        }
        p => build_for_platform(p, sea_blob, output)?,
    }
    Ok(())
}

/// Creates an executable file for a specific platform
fn build_for_platform(
    platform: &str,
    sea_blob: &PathBuf,
    output: &PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("   Building for {}...", platform);

    let (node_binary, output_name) = match platform {
        "linux" => ("node-linux-x64", "app-linux"),
        "macos" => ("node-macos-x64", "app-macos"),
        "windows" => ("node-windows-x64.exe", "app-windows.exe"),
        _ => return Err(format!("Unknown platform: {}", platform).into()),
    };

    // Copy Node.js binary
    let node_src = get_node_binary_path(node_binary)?;
    let exe_path = output.join(output_name);

    fs::copy(&node_src, &exe_path)?;

    // on Unix make executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&exe_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&exe_path, perms)?;
    }

    // inject SEA blob to binary
    inject_sea_blob(&exe_path, sea_blob, platform)?;

    println!("      ✓ {}", output_name);
    Ok(())
}

/// Inject SEA blob in Node.js binary
fn inject_sea_blob(
    exe_path: &PathBuf,
    sea_blob: &PathBuf,
    platform: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    // There are different injection utilities for different platforms
    match platform {
        "macos" => {
            // On macOS, we use codesign after injection
            inject_blob_posix(exe_path, sea_blob)?;
            
            // Deleting the signature (if any)
            Command::new("codesign")
                .arg("--remove-signature")
                .arg(exe_path)
                .output()?;
        }
        "windows" => {
            // On Windows, we use postject
            inject_blob_windows(exe_path, sea_blob)?;
        }
        "linux" => {
            inject_blob_posix(exe_path, sea_blob)?;
        }
        _ => return Err(format!("Unknown platform: {}", platform).into()),
    }

    Ok(())
}

/// Injection for POSIX systems (Linux, macOS)
fn inject_blob_posix(
    exe_path: &PathBuf,
    sea_blob: &PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let status = Command::new("npx")
        .arg("postject")
        .arg(exe_path)
        .arg("NODE_SEA_BLOB")
        .arg(sea_blob)
        .arg("--sentinel-fuse")
        .arg("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2")
        .status()?;

    if !status.success() {
        return Err("Failed to inject SEA blob".into());
    }

    Ok(())
}

/// inject for Windows
fn inject_blob_windows(
    exe_path: &PathBuf,
    sea_blob: &PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let status = Command::new("npx")
        .arg("postject")
        .arg(exe_path)
        .arg("NODE_SEA_BLOB")
        .arg(sea_blob)
        .arg("--sentinel-fuse")
        .arg("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2")
        .status()?;

    if !status.success() {
        return Err("Failed to inject SEA blob".into());
    }

    Ok(())
}

/// Find path for bundler script
fn get_bundler_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    // In production, bundler will be embedded or in a known location
    // While we are looking for a relatively executable
    let exe_dir = std::env::current_exe()?
        .parent()
        .ok_or("Cannot get exe dir")?
        .to_path_buf();

    let bundler = exe_dir.join("../bundler/index.js");
    
    if bundler.exists() {
        return Ok(bundler);
    }

    // Fallback on current directory
    let bundler = PathBuf::from("bundler/index.js");
    if bundler.exists() {
        return Ok(bundler);
    }

    Err("Cannot find bundler/index.js".into())
}

/// Finds the Node.js binary for the platform
fn get_node_binary_path(binary_name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    // In production, the binaries will be embedded or loaded
    // While using the system node
    
    let output = Command::new("which").arg("node").output()?;
    
    if output.status.success() {
        let path = String::from_utf8(output.stdout)?.trim().to_string();
        return Ok(PathBuf::from(path));
    }

    Err("Cannot find Node.js binary".into())
}