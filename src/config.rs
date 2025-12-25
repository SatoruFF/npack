use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

// Импортируем Args из main.rs
use crate::Args;

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
pub struct NpackConfig {
    /// Git repository URL or local path
    pub source: Option<String>,

    /// Entry point file
    pub entry: Option<String>,

    /// Target platform (host, windows, linux, macos)
    pub platform: Option<String>,

    /// Node.js version
    pub node_version: Option<String>,

    /// Output directory
    pub output: Option<PathBuf>, // ← Измени на PathBuf

    /// Run postinstall script
    pub run_postinstall: Option<bool>,

    /// Environment variables for postinstall
    pub env: Option<HashMap<String, String>>,

    /// Additional assets to include
    pub assets: Option<Vec<String>>,

    /// Scripts to include (like migrations)
    pub scripts: Option<Vec<String>>,

    /// Database connection string
    pub db_connection: Option<String>,

    /// S3 Key for packages
    pub s3_key: Option<String>,

    /// S3 Secret for packages
    pub s3_secret: Option<String>,
}

impl NpackConfig {
    /// Load config from file
    pub fn from_file(path: &PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let content = fs::read_to_string(path)?;
        let config: NpackConfig = serde_json::from_str(&content)?;
        Ok(config)
    }

    /// Try to find config in current directory
    pub fn find_in_cwd() -> Option<Self> {
        let config_names = ["npack.config.json", ".npackrc", "npack.json"];

        for name in &config_names {
            let path = PathBuf::from(name);
            if path.exists() {
                if let Ok(config) = Self::from_file(&path) {
                    println!("📋 Loaded config from: {}", name);
                    return Some(config);
                }
            }
        }

        None
    }

    /// Merge with CLI args (CLI args override config)
    pub fn merge_with_args(&mut self, args: &Args) {
        // Source (позиционный аргумент или из конфига)
        if args.source.is_some() {
            self.source = args.source.clone();
        }

        // Entry point
        if args.entry.is_some() {
            self.entry = args.entry.clone();
        }

        // Platform
        if let Some(platform) = &args.platform {
            self.platform = Some(platform.clone());
        }

        // Node version
        if let Some(node_version) = &args.node_version {
            self.node_version = Some(node_version.clone());
        }

        // Output directory
        if let Some(output) = &args.output {
            self.output = Some(output.clone());
        }

        // Postinstall flag
        if args.run_postinstall {
            self.run_postinstall = Some(true);
        }

        // Database connection
        if args.db_connection.is_some() {
            self.db_connection = args.db_connection.clone();
        }

        // S3 credentials
        if args.s3_key.is_some() {
            self.s3_key = args.s3_key.clone();
        }
        if args.s3_secret.is_some() {
            self.s3_secret = args.s3_secret.clone();
        }
    }

    /// Get final source (from config or error)
    pub fn get_source(&self) -> Result<String, &'static str> {
        self.source
            .clone()
            .ok_or("Source is required (specify in config or as argument)")
    }

    /// Get final entry point
    pub fn get_entry(&self) -> Option<String> {
        self.entry.clone()
    }

    /// Get final platform (default to "host")
    pub fn get_platform(&self) -> String {
        self.platform.clone().unwrap_or_else(|| "host".to_string())
    }

    /// Get final node version (default to "24.12.0")
    pub fn get_node_version(&self) -> String {
        self.node_version
            .clone()
            .unwrap_or_else(|| "24.12.0".to_string())
    }

    /// Get final output directory (default to "./dist")
    pub fn get_output(&self) -> PathBuf {
        self.output
            .clone()
            .unwrap_or_else(|| PathBuf::from("./dist"))
    }

    /// Should run postinstall?
    pub fn should_run_postinstall(&self) -> bool {
        self.run_postinstall.unwrap_or(false)
    }

    /// Get environment variables map
    pub fn get_env_vars(&self) -> HashMap<String, String> {
        let mut env = self.env.clone().unwrap_or_default();

        // Добавляем DB и S3 если указаны отдельно
        if let Some(db) = &self.db_connection {
            env.insert("DB_CONNECTION_STRING".to_string(), db.clone());
        }
        if let Some(key) = &self.s3_key {
            env.insert("PACKAGES_STORAGE_S3_KEY".to_string(), key.clone());
        }
        if let Some(secret) = &self.s3_secret {
            env.insert("PACKAGES_STORAGE_S3_SECRET".to_string(), secret.clone());
        }

        env
    }

    /// Get assets patterns
    pub fn get_assets(&self) -> Vec<String> {
        self.assets.clone().unwrap_or_default()
    }

    /// Get scripts patterns
    pub fn get_scripts(&self) -> Vec<String> {
        self.scripts.clone().unwrap_or_default()
    }

    /// Validate config
    pub fn validate(&self) -> Result<(), String> {
        if self.source.is_none() {
            return Err("Source is required".to_string());
        }

        // Проверка платформы
        if let Some(platform) = &self.platform {
            match platform.as_str() {
                "host" | "windows" | "linux" | "macos" => {}
                _ => {
                    return Err(format!(
                        "Invalid platform: {}. Use: host, windows, linux, or macos",
                        platform
                    ))
                }
            }
        }

        Ok(())
    }
}

// #[cfg(test)]
// mod tests {
//     use super::*;

//     #[test]
//     fn test_default_config() {
//         let config = NpackConfig::default();
//         assert_eq!(config.get_platform(), "host");
//         assert_eq!(config.get_node_version(), "24.12.0");
//         assert_eq!(config.get_output(), "./dist");
//     }

//     #[test]
//     fn test_env_vars_merge() {
//         let mut config = NpackConfig::default();
//         config.db_connection = Some("postgres://localhost".to_string());
//         config.s3_key = Some("key123".to_string());

//         let env = config.get_env_vars();
//         assert_eq!(
//             env.get("DB_CONNECTION_STRING"),
//             Some(&"postgres://localhost".to_string())
//         );
//         assert_eq!(
//             env.get("PACKAGES_STORAGE_S3_KEY"),
//             Some(&"key123".to_string())
//         );
//     }
// }
