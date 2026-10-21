//! 导入演示：命令行验证导入功能
//!
//! 运行：cargo run --example import_demo -- "C:\path\to\theme.zip"

use mousetool_theme_lib::utils::{importer, paths};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(zip_path) = args.get(1) else {
        println!("用法: cargo run --example import_demo -- <zip 路径>");
        return;
    };

    println!("数据根目录: {}", paths::data_root().display());
    println!("导入: {zip_path}");
    println!();

    match importer::import_zip(zip_path) {
        Ok(theme) => {
            println!("✓ 导入成功");
            println!("  名称: {}", theme.name);
            println!("  ID  : {}", theme.id);
            println!("  槽位: {} 个", theme.cursors.len());
            for slot in &theme.cursors {
                println!("    {:<12} {}", slot.registry_key, slot.file_path);
            }
            println!();
            println!("  主题目录: {}", paths::theme_dir(&theme.id).display());

            let (all, warnings) = importer::read_user_themes();
            for warn in &warnings {
                println!("  ! {warn}");
            }
            println!("  已导入主题总数: {}", all.len());
        }
        Err(err) => println!("✗ 导入失败: {err}"),
    }
}
