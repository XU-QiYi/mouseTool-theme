use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use base64::Engine;
use image::{DynamicImage, GenericImageView};

use crate::models::CursorPreview;
use crate::utils::limits;

/// 单帧最长边上限，避免高分辨率光标撑爆 IPC
const MAX_EDGE: u32 = 128;
/// .ani 解析的最大帧数上限
const MAX_FRAMES: usize = 32;
/// rate 缺失时的默认帧间隔（毫秒）
const DEFAULT_RATE_MS: u32 = 100;

/// 把图像缩到最长边 128px 以内，再编码为 PNG base64
fn to_base64_png(img: &DynamicImage) -> String {
    let (w, h) = img.dimensions();
    let scaled = if w.max(h) > MAX_EDGE {
        img.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::CatmullRom)
    } else {
        img.clone()
    };
    let mut png = Vec::new();
    if scaled
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .is_err()
    {
        return String::new();
    }
    base64::engine::general_purpose::STANDARD.encode(png)
}

/// 解析 .cur / .ico 文件，返回 (图像, 热点坐标)
///
/// .cur 本质是 ICO 容器，热点坐标存于目录项的 wPlanes/wBitCount 字段。
pub fn parse_cur(bytes: &[u8]) -> Option<(DynamicImage, (u32, u32))> {
    if bytes.len() < 6 {
        return None;
    }
    // ICONDIR: reserved(2) type(2) count(2)
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    if count == 0 {
        return None;
    }

    // 取面积最大的目录项（兼容多尺寸：16/32/48/256）
    // (宽, 高, 热点x, 热点y, 数据起始, 数据长度, 目录项偏移)
    let mut best: Option<(u32, u32, u32, u32, usize, usize, usize)> = None;
    for i in 0..count {
        let e = 6 + i * 16;
        if e + 16 > bytes.len() {
            return None;
        }
        let w = bytes[e] as u32;
        let h = bytes[e + 1] as u32;
        let hx = u16::from_le_bytes([bytes[e + 4], bytes[e + 5]]) as u32;
        let hy = u16::from_le_bytes([bytes[e + 6], bytes[e + 7]]) as u32;
        let size = u32::from_le_bytes(bytes[e + 8..e + 12].try_into().ok()?) as usize;
        let offset = u32::from_le_bytes(bytes[e + 12..e + 16].try_into().ok()?) as usize;
        // 尺寸字段为 0 表示 256px（8bit 溢出约定）
        let real_w = if w == 0 { 256 } else { w };
        let real_h = if h == 0 { 256 } else { h };
        if best.map_or(true, |(bw, bh, ..)| real_w * real_h > bw * bh) {
            best = Some((real_w, real_h, hx, hy, offset, size, e));
        }
    }

    let (_, _, hx, hy, start, len, entry) = best?;
    let img = decode_icon_image(bytes, entry, start, len)?;
    Some((img, (hx, hy)))
}

/// 把单个 icon 目录项拼成一个「只含一帧」的 ICO 文件，交给 image 官方解码器
///
/// ICO 内嵌的数据可能是裸 DIB（无 BMP 文件头）或 PNG，且 DIB 的高度信息包含 AND
/// mask、需特殊处理。这里不自己解这些细节，而是合成单帧 ICO 复用官方解码器。
fn decode_icon_image(bytes: &[u8], entry: usize, start: usize, len: usize) -> Option<DynamicImage> {
    // ICONDIR(6) + ICONDIRENTRY(16) + 图像数据
    let mut synth = Vec::with_capacity(22 + len);
    synth.extend_from_slice(&[0, 0]); // reserved
    synth.extend_from_slice(&[2, 0]); // type: 2 = cursor
    synth.extend_from_slice(&[1, 0]); // image count: 1

    let mut entry_bytes = bytes.get(entry..entry + 16)?.to_vec();
    entry_bytes[8..12].copy_from_slice(&(len as u32).to_le_bytes()); // dwBytesInRes
    entry_bytes[12..16].copy_from_slice(&22u32.to_le_bytes()); // dwImageOffset
    synth.extend_from_slice(&entry_bytes);
    synth.extend_from_slice(bytes.get(start..start + len)?);

    image::load_from_memory_with_format(&synth, image::ImageFormat::Ico).ok()
}

/// JIF（1/60 秒）转毫秒，并夹到合理区间
fn jif_to_ms(v: u32) -> u32 {
    let ms = (v as u64 * 1000 / 60) as u32;
    ms.clamp(16, 1000)
}

/// 解析 .ani（RIFF/ACON 容器），逐帧提取 .cur 数据
pub fn parse_ani(bytes: &[u8]) -> Option<CursorPreview> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"ACON" {
        return None;
    }

    let mut step_rate: Option<u32> = None;
    let mut rate_first: Option<u32> = None;
    let mut icons: Vec<&[u8]> = Vec::new();

    let mut pos = 12usize;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().ok()?) as usize;
        let data_start = pos + 8;
        let data_end = data_start.saturating_add(size).min(bytes.len());
        let data = &bytes[data_start..data_end];

        match id {
            b"anih" => {
                // anih 结构：cbSize(4) nFrames(4) nSteps(4) iWidth(4) iHeight(4) iStepRate(4) ...
                if data.len() >= 24 {
                    step_rate = Some(u32::from_le_bytes(data[20..24].try_into().ok()?));
                }
            }
            b"rate" => {
                if data.len() >= 4 {
                    rate_first = Some(u32::from_le_bytes(data[0..4].try_into().ok()?));
                }
            }
            b"LIST" => {
                // LIST 块 data 前 4 字节是列表类型，帧列表为 "fram"
                if data.len() >= 8 && &data[0..4] == b"fram" {
                    let mut sub = 4usize;
                    while sub + 8 <= data.len() {
                        let ssize = u32::from_le_bytes(
                            data[sub + 4..sub + 8].try_into().ok()?,
                        ) as usize;
                        let sdata = &data[sub + 8..(sub + 8 + ssize).min(data.len())];
                        if &data[sub..sub + 4] == b"icon" {
                            icons.push(sdata);
                        }
                        sub = sub + 8 + ssize + (ssize & 1);
                    }
                }
            }
            _ => {}
        }
        pos = data_start + size + (size & 1);
    }

    if icons.is_empty() {
        return None;
    }

    let rate_ms = match rate_first.or(step_rate) {
        Some(v) if v > 0 => jif_to_ms(v),
        _ => DEFAULT_RATE_MS,
    };

    let mut frames = Vec::new();
    let mut first_image = None;
    let mut hotspot = (0u32, 0u32);

    for icon in icons.iter().take(MAX_FRAMES) {
        if let Some((img, hs)) = parse_cur(icon) {
            if first_image.is_none() {
                first_image = Some(to_base64_png(&img));
                hotspot = hs;
            }
            frames.push(to_base64_png(&img));
        }
    }

    // 所有帧都解不出来：按规范返回 None，由上层降级
    let image = first_image?;
    if frames.is_empty() {
        return None;
    }

    Some(CursorPreview {
        is_animated: frames.len() > 1,
        image,
        frames,
        rate_ms,
        hotspot,
    })
}

/// 解析静态 .cur 文件为预览
pub fn parse_cur_preview(bytes: &[u8]) -> Option<CursorPreview> {
    let (img, hotspot) = parse_cur(bytes)?;
    let image = to_base64_png(&img);
    if image.is_empty() {
        return None;
    }
    Some(CursorPreview {
        is_animated: false,
        frames: vec![image.clone()],
        image,
        rate_ms: 0,
        hotspot,
    })
}

/// 预览缓存：key 为 (路径, 修改时间秒, 大小)，同一文件只解析一次
static CACHE: LazyLock<Mutex<HashMap<(String, u64, u64), Arc<CursorPreview>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn cache_key(path: &Path) -> Option<(String, u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let size = meta.len();
    // 预览上限：超大文件不读、不解析，也不进缓存
    if size > limits::MAX_PREVIEW_BYTES {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((path.to_string_lossy().into_owned(), mtime, size))
}

/// 读取并解析光标文件；任何失败都返回空预览，不报错
pub fn preview_file(path: &str) -> CursorPreview {
    let key = match cache_key(Path::new(path)) {
        Some(k) => k,
        None => return CursorPreview::default(),
    };

    if let Some(hit) = CACHE.lock().unwrap().get(&key) {
        return (**hit).clone();
    }

    let result = std::fs::read(path)
        .ok()
        .and_then(|bytes| match Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref()
        {
            Some("ani") => parse_ani(&bytes),
            Some("cur") | Some("ico") => parse_cur_preview(&bytes),
            _ => parse_cur_preview(&bytes),
        })
        .unwrap_or_default();

    let shared = Arc::new(result);
    CACHE
        .lock()
        .unwrap()
        .insert(key, shared.clone());
    (*shared).clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_support::{fixture_ani, fixture_cur, TempDir};

    #[test]
    fn 能解析静态光标() {
        let p = parse_cur_preview(&fixture_cur()).expect("解析 fixture .cur 应成功");
        assert!(!p.image.is_empty());
        assert!(!p.is_animated);
        assert_eq!(p.hotspot, (0, 0));
    }

    #[test]
    fn 能解析动态光标且帧率合理() {
        let p = parse_ani(&fixture_ani()).expect("解析 fixture .ani 应成功");
        assert!(p.is_animated, "应有多帧，实际 {}", p.frames.len());
        assert_eq!(p.frames.len(), 2);
        assert_eq!(p.rate_ms, 100);
        assert!(p.frames.len() <= MAX_FRAMES);
        assert_eq!(p.hotspot, (0, 0));
    }

    #[test]
    fn 不存在的文件返回空预览() {
        let p = preview_file(r"C:\不存在\nope.cur");
        assert!(!p.is_animated);
        assert!(p.image.is_empty());
        assert!(p.frames.is_empty());
    }

    #[test]
    fn 缓存命中同一实例() {
        let dir = TempDir::new("cursor-cache");
        let file = dir.join("arrow.cur");
        std::fs::write(&file, fixture_cur()).expect("写 fixture");
        let path = file.to_string_lossy().into_owned();

        preview_file(&path);
        let a = preview_file(&path);
        let b = preview_file(&path);
        assert_eq!(a.image, b.image);
        assert!(CACHE
            .lock()
            .unwrap()
            .contains_key(&cache_key(&file).unwrap()));
    }

    #[test]
    fn 超过预览上限的文件不读也不缓存() {
        let dir = TempDir::new("cursor-large");
        let file = dir.join("huge.cur");
        let handle = std::fs::File::create(&file).expect("建大文件");
        handle
            .set_len(limits::MAX_PREVIEW_BYTES + 1)
            .expect("撑大文件");

        assert!(cache_key(&file).is_none(), "超限文件不该生成缓存键");
        let p = preview_file(&file.to_string_lossy());
        assert!(p.image.is_empty());
    }

    #[test]
    fn jif换算正确() {
        assert_eq!(jif_to_ms(6), 100); // 6/60s = 100ms
        assert_eq!(jif_to_ms(0), 16); // 下限
    }
}
