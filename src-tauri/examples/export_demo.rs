//! 导出演示：命令行验证导出功能，不需要打开应用窗口
//!
//! 运行：
//!   cargo run --example export_demo                 # 导出第一个系统方案
//!   cargo run --example export_demo -- "极光"        # 按名称匹配主题
//!
//! 用途：验证「系统方案也能导出」这条路径——它没有磁盘目录，只有注册表里的
//! 光标文件路径，是最容易在界面里被忽略的分支。

use mousetool_theme_lib::commands::theme::export_theme;
use mousetool_theme_lib::models::CursorTheme;
use mousetool_theme_lib::utils::{importer, registry};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let keyword = args.get(1).cloned().unwrap_or_default();

    let mut candidates: Vec<CursorTheme> = registry::read_system_schemes().unwrap_or_default();
    let user = importer::read_user_themes().0;
    candidates.extend(user);

    let Some(theme) = candidates
        .iter()
        .find(|t| keyword.is_empty() || t.name.contains(&keyword))
        .cloned()
    else {
        println!("没有匹配「{keyword}」的主题（共 {} 个候选）", candidates.len());
        return;
    };

    let safe_name: String = theme
        .name
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    let dest = std::env::temp_dir().join(format!("export-demo-{safe_name}.zip"));

    println!("主题：{}（{} 个槽位，内置={}）", theme.name, theme.cursors.len(), theme.is_built_in);

    match export_theme(theme, dest.to_string_lossy().into_owned()) {
        Ok(summary) => {
            println!("导出 {} 个光标文件 → {}", summary.file_count, dest.display());
            if !summary.skipped.is_empty() {
                println!("跳过 {} 个：{:?}", summary.skipped.len(), summary.skipped);
            }

            let file = std::fs::File::open(&dest).expect("打开导出的 zip");
            let mut archive = zip::ZipArchive::new(file).expect("解析导出的 zip");
            println!("包内文件：");
            for i in 0..archive.len() {
                let entry = archive.by_index(i).expect("读取条目");
                println!("  - {}（{} 字节）", entry.name(), entry.size());
            }
        }
        Err(err) => println!("导出失败：{err}"),
    }
}
