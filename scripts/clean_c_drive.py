# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""C盘清理脚本 - 安全清理常见的空间占用"""

import os
import shutil
import subprocess
import sys
from pathlib import Path
from dataclasses import dataclass


@dataclass
class CleanResult:
    name: str
    freed_bytes: int
    errors: list[str]


def get_size(path: Path) -> int:
    """获取目录大小，忽略权限错误"""
    total = 0
    try:
        for entry in os.scandir(path):
            try:
                if entry.is_file(follow_symlinks=False):
                    total += entry.stat().st_size
                elif entry.is_dir(follow_symlinks=False):
                    total += get_size(Path(entry.path))
            except (PermissionError, OSError):
                pass
    except (PermissionError, OSError):
        pass
    return total


def safe_rmtree(path: Path, dry_run: bool = False) -> tuple[int, list[str]]:
    """安全删除目录，返回释放的字节数和错误列表"""
    errors = []
    freed = 0

    if not path.exists():
        return 0, []

    if dry_run:
        return get_size(path), []

    for entry in os.scandir(path):
        try:
            entry_path = Path(entry.path)
            if entry.is_file(follow_symlinks=False):
                size = entry.stat().st_size
                entry_path.unlink()
                freed += size
            elif entry.is_dir(follow_symlinks=False):
                sub_freed, sub_errors = safe_rmtree(entry_path, dry_run)
                freed += sub_freed
                errors.extend(sub_errors)
        except (PermissionError, OSError) as e:
            errors.append(f"{entry.path}: {e}")

    return freed, errors


def safe_delete_files(directory: Path, pattern: str, dry_run: bool = False) -> tuple[int, list[str]]:
    """安全删除匹配模式的文件"""
    errors = []
    freed = 0

    if not directory.exists():
        return 0, []

    for file in directory.glob(pattern):
        try:
            if file.is_file():
                size = file.stat().st_size
                if not dry_run:
                    file.unlink()
                freed += size
        except (PermissionError, OSError) as e:
            errors.append(f"{file}: {e}")

    return freed, errors


def clean_windows_temp(dry_run: bool = False) -> CleanResult:
    """清理 Windows 临时文件"""
    temp_dirs = [
        Path(os.environ.get("TEMP", "")),
        Path(os.environ.get("TMP", "")),
        Path("C:/Windows/Temp"),
    ]

    total_freed = 0
    all_errors = []

    for temp_dir in temp_dirs:
        if not temp_dir.exists():
            continue

        freed, errors = safe_rmtree(temp_dir, dry_run)
        total_freed += freed
        all_errors.extend(errors)

    return CleanResult("Windows 临时文件", total_freed, all_errors)


def clean_windows_update_cache(dry_run: bool = False) -> CleanResult:
    """清理 Windows Update 缓存"""
    cache_dir = Path("C:/Windows/SoftwareDistribution/Download")

    freed, errors = safe_rmtree(cache_dir, dry_run)
    return CleanResult("Windows Update 缓存", freed, errors)


def clean_thumbnail_cache(dry_run: bool = False) -> CleanResult:
    """清理缩略图缓存"""
    cache_dir = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Windows/Explorer"

    total_freed = 0
    all_errors = []

    if cache_dir.exists():
        for pattern in ["thumbcache_*.db", "iconcache_*.db"]:
            freed, errors = safe_delete_files(cache_dir, pattern, dry_run)
            total_freed += freed
            all_errors.extend(errors)

    return CleanResult("缩略图缓存", total_freed, all_errors)


def clean_browser_caches(dry_run: bool = False) -> CleanResult:
    """清理常见浏览器缓存"""
    local_app_data = Path(os.environ.get("LOCALAPPDATA", ""))
    total_freed = 0
    all_errors = []

    browser_cache_dirs = [
        # Chrome
        local_app_data / "Google/Chrome/User Data/Default/Cache",
        local_app_data / "Google/Chrome/User Data/Default/Code Cache",
        # Edge
        local_app_data / "Microsoft/Edge/User Data/Default/Cache",
        local_app_data / "Microsoft/Edge/User Data/Default/Code Cache",
        # Firefox
        local_app_data / "Mozilla/Firefox/Profiles",
    ]

    for cache_dir in browser_cache_dirs:
        if cache_dir.exists():
            freed, errors = safe_rmtree(cache_dir, dry_run)
            total_freed += freed
            all_errors.extend(errors)

    return CleanResult("浏览器缓存", total_freed, all_errors)


def clean_recycle_bin(dry_run: bool = False) -> CleanResult:
    """清理回收站"""
    try:
        # 使用 PowerShell 清空回收站
        if not dry_run:
            subprocess.run(
                ["powershell", "-Command", "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"],
                capture_output=True,
                timeout=30,
            )
        return CleanResult("回收站", 0, [])
    except Exception as e:
        return CleanResult("回收站", 0, [str(e)])


def clean_old_logs(dry_run: bool = False) -> CleanResult:
    """清理 Windows 日志文件"""
    log_dirs = [
        Path("C:/Windows/Logs"),
        Path(os.environ.get("LOCALAPPDATA", "")) / "CrashDumps",
    ]

    total_freed = 0
    all_errors = []

    for log_dir in log_dirs:
        if log_dir.exists():
            freed, errors = safe_rmtree(log_dir, dry_run)
            total_freed += freed
            all_errors.extend(errors)

    return CleanResult("日志文件", total_freed, all_errors)


def format_size(size_bytes: int) -> str:
    """格式化文件大小"""
    for unit in ["B", "KB", "MB", "GB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.2f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.2f} TB"


def get_disk_usage() -> dict:
    """获取磁盘使用情况"""
    try:
        import ctypes
        free_bytes = ctypes.c_ulonglong(0)
        total_bytes = ctypes.c_ulonglong(0)
        ctypes.windll.kernel32.GetDiskFreeSpaceExW(
            "C:\\", None, ctypes.pointer(total_bytes), ctypes.pointer(free_bytes)
        )
        return {
            "total": total_bytes.value,
            "free": free_bytes.value,
            "used": total_bytes.value - free_bytes.value,
        }
    except Exception:
        return {"total": 0, "free": 0, "used": 0}


def main():
    import argparse

    parser = argparse.ArgumentParser(description="C盘清理工具")
    parser.add_argument("--dry-run", action="store_true", help="模拟运行，不实际删除文件")
    parser.add_argument("--all", action="store_true", help="执行所有清理任务")
    parser.add_argument("--temp", action="store_true", help="清理临时文件")
    parser.add_argument("--update-cache", action="store_true", help="清理 Windows Update 缓存")
    parser.add_argument("--thumbnails", action="store_true", help="清理缩略图缓存")
    parser.add_argument("--browsers", action="store_true", help="清理浏览器缓存")
    parser.add_argument("--recycle-bin", action="store_true", help="清空回收站")
    parser.add_argument("--logs", action="store_true", help="清理日志文件")

    args = parser.parse_args()

    # 如果没有指定任何选项，默认显示帮助
    if not any([args.all, args.temp, args.update_cache, args.thumbnails,
                args.browsers, args.recycle_bin, args.logs]):
        parser.print_help()
        return

    # 清理任务列表
    tasks = []
    if args.all or args.temp:
        tasks.append(("temp", clean_windows_temp))
    if args.all or args.update_cache:
        tasks.append(("update_cache", clean_windows_update_cache))
    if args.all or args.thumbnails:
        tasks.append(("thumbnails", clean_thumbnail_cache))
    if args.all or args.browsers:
        tasks.append(("browsers", clean_browser_caches))
    if args.all or args.recycle_bin:
        tasks.append(("recycle_bin", clean_recycle_bin))
    if args.all or args.logs:
        tasks.append(("logs", clean_old_logs))

    # 获取清理前的磁盘状态
    disk_before = get_disk_usage()

    print("=" * 60)
    print("C盘清理工具")
    print("=" * 60)
    print(f"\n当前磁盘状态:")
    print(f"  总容量: {format_size(disk_before['total'])}")
    print(f"  已使用: {format_size(disk_before['used'])}")
    print(f"  可用:   {format_size(disk_before['free'])}")
    print()

    if args.dry_run:
        print("[DRY RUN] 模拟运行模式 - 不会实际删除任何文件\n")

    total_freed = 0
    all_errors = []

    for name, task_func in tasks:
        result = task_func(dry_run=args.dry_run)
        total_freed += result.freed_bytes
        all_errors.extend(result.errors)

        status = "[OK]" if not result.errors else "[WARN]"
        print(f"{status} {result.name}: {format_size(result.freed_bytes)}")

    print()
    print("-" * 60)
    print(f"预计释放空间: {format_size(total_freed)}")

    if all_errors:
        print(f"\n遇到 {len(all_errors)} 个错误 (可能是权限不足):")
        for error in all_errors[:5]:  # 只显示前5个错误
            print(f"  - {error}")
        if len(all_errors) > 5:
            print(f"  ... 还有 {len(all_errors) - 5} 个错误")

    if not args.dry_run and total_freed > 0:
        disk_after = get_disk_usage()
        print(f"\n清理后磁盘状态:")
        print(f"  可用: {format_size(disk_after['free'])} (释放了 {format_size(disk_after['free'] - disk_before['free'])})")

    print("=" * 60)


if __name__ == "__main__":
    main()
