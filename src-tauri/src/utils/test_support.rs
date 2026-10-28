//! 测试专用：临时目录、路径隔离与光标 fixture
//!
//! 临时目录用 dev 依赖 `tempfile`（决策 27）：Drop 即清理，不必自己维护唯一命名
//! 与删除逻辑；光标 fixture 由代码生成，测试不依赖 `C:\Windows\Cursors` 里是否
//! 存在某个文件。

#![cfg(test)]

use std::fs;
use std::path::{Path, PathBuf};

use crate::utils::paths;

/// 一个用例独占的临时目录，离开作用域自动删除
pub struct TempDir {
    inner: tempfile::TempDir,
}

impl TempDir {
    pub fn new(label: &str) -> Self {
        let inner = tempfile::Builder::new()
            .prefix(&format!("cursorstudio-test-{label}-"))
            .tempdir()
            .expect("创建测试临时目录");
        Self { inner }
    }

    pub fn path(&self) -> &Path {
        self.inner.path()
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.inner.path().join(name)
    }

    /// 把全局数据目录与主题目录重定向到这个临时目录
    pub fn isolate_paths(&self) -> paths::TestRootsGuard {
        let data = self.path().join("data");
        let themes = data.join("themes");
        fs::create_dir_all(&themes).expect("建测试主题目录");
        paths::use_test_roots(data, themes)
    }
}

/// 生成一个 32×32、单帧、热点 (0,0) 的合法 .cur
pub fn fixture_cur() -> Vec<u8> {
    const W: u32 = 32;
    const H: u32 = 32;
    let pixels = W * H * 4;
    let mask = (W / 8) * H;
    let image_size = 40 + pixels + mask;

    let mut out = Vec::with_capacity(22 + image_size as usize);
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&2u16.to_le_bytes()); // type: cursor
    out.extend_from_slice(&1u16.to_le_bytes()); // count

    // ICONDIRENTRY：wPlanes / wBitCount 在 .cur 里承载热点坐标
    out.push(W as u8);
    out.push(H as u8);
    out.push(0); // color count
    out.push(0); // reserved
    out.extend_from_slice(&0u16.to_le_bytes()); // hotspot x
    out.extend_from_slice(&0u16.to_le_bytes()); // hotspot y
    out.extend_from_slice(&image_size.to_le_bytes());
    out.extend_from_slice(&22u32.to_le_bytes());

    // BITMAPINFOHEADER：高度是双倍（含 AND mask）
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(W as i32).to_le_bytes());
    out.extend_from_slice(&((H * 2) as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    // BGRA 像素：不透明蓝色，方便肉眼确认预览确实画出来了
    for _ in 0..W * H {
        out.extend_from_slice(&[0xE0, 0x60, 0x20, 0xFF]);
    }
    out.extend(std::iter::repeat_n(0u8, mask as usize));

    out
}

fn chunk(id: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + data.len() + 1);
    out.extend_from_slice(id);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    if data.len() % 2 == 1 {
        out.push(0);
    }
    out
}

/// 生成一个两帧的 RIFF/ACON 动态光标（帧内容来自 `fixture_cur`）
pub fn fixture_ani() -> Vec<u8> {
    let mut anih = vec![0u8; 36];
    anih[0..4].copy_from_slice(&36u32.to_le_bytes()); // cbSize
    anih[4..8].copy_from_slice(&2u32.to_le_bytes()); // nFrames
    anih[8..12].copy_from_slice(&2u32.to_le_bytes()); // nSteps
    anih[20..24].copy_from_slice(&6u32.to_le_bytes()); // iStepRate = 6 JIF = 100ms

    let frame = fixture_cur();
    let mut list_payload = b"fram".to_vec();
    list_payload.extend(chunk(b"icon", &frame));
    list_payload.extend(chunk(b"icon", &frame));

    let mut body = Vec::new();
    body.extend(chunk(b"anih", &anih));
    body.extend(chunk(b"rate", &6u32.to_le_bytes()));
    body.extend(chunk(b"LIST", &list_payload));

    let mut out = Vec::with_capacity(12 + body.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((4 + body.len()) as u32).to_le_bytes());
    out.extend_from_slice(b"ACON");
    out.extend_from_slice(&body);
    out
}

/// 在目录里放一套最小可识别的光标：arrow.cur + busy.ani
pub fn write_cursor_fixtures(dir: &Path) {
    fs::create_dir_all(dir).expect("建 fixture 目录");
    fs::write(dir.join("arrow.cur"), fixture_cur()).expect("写 arrow.cur");
    fs::write(dir.join("busy.ani"), fixture_ani()).expect("写 busy.ani");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::cursor;

    #[test]
    fn 临时目录离开作用域即删除() {
        let path = {
            let dir = TempDir::new("drop");
            let path = dir.path().to_path_buf();
            assert!(path.is_dir());
            path
        };
        assert!(!path.exists(), "TempDir 应该清理自己");
    }

    #[test]
    fn 生成的_cur_能被预览解析() {
        let preview = cursor::parse_cur_preview(&fixture_cur()).expect("fixture .cur 应可解析");
        assert!(!preview.image.is_empty());
        assert!(!preview.is_animated);
    }

    #[test]
    fn 生成的_ani_能被预览解析() {
        let preview = cursor::parse_ani(&fixture_ani()).expect("fixture .ani 应可解析");
        assert!(preview.is_animated);
        assert_eq!(preview.frames.len(), 2);
        assert_eq!(preview.rate_ms, 100);
    }
}
