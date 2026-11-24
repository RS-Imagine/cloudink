use flate2::{Decompress, FlushDecompress, Status};

use crate::icon::IconError;

const PNG: &[u8] = &[137, 80, 78, 71, 13, 10, 26, 10];
const DECODE_LIMIT: usize = 4 * 1024 * 1024;
const INVALID_PNG: IconError = IconError::bad("ICO 中的 PNG 图像不完整或校验失败。");
const INVALID_PIXELS: IconError = IconError::bad("ICO 中的 PNG 压缩数据或扫描行无效。");
const INVALID_ICO: IconError = IconError::bad("ICO 文件结构无效或图像数据不完整，请重新导出图标。");

pub fn validate_derived_png(bytes: &[u8], size: usize) -> Result<(), IconError> {
    if bytes.len() < 24 || !bytes.starts_with(PNG) {
        return Err(IconError::message(
            400,
            format!("派生图标 {size}×{size} 不是有效的 PNG 图片。"),
        ));
    }
    validate_png(bytes, size, size, DECODE_LIMIT)
        .map(drop)
        .map_err(|error| {
            if error.status == 413 {
                error
            } else {
                IconError::message(
                    400,
                    format!("派生图标 {size}×{size} 的尺寸或 PNG 结构校验失败。"),
                )
            }
        })
}

pub fn validate_ico(bytes: &[u8]) -> Result<(), IconError> {
    if bytes.len() < 22 {
        return Err(INVALID_ICO);
    }
    let count = le16(bytes, 4);
    let directory_end = 6 + count * 16;
    if le16(bytes, 0) != 0
        || le16(bytes, 2) != 1
        || !(1..=64).contains(&count)
        || directory_end > bytes.len()
    {
        return Err(INVALID_ICO);
    }
    let mut remaining = DECODE_LIMIT;
    for entry in bytes[6..directory_end].as_chunks::<16>().0 {
        let size = le32(entry, 8);
        let offset = le32(entry, 12);
        if entry[3] != 0 || offset < directory_end || size < 24 {
            return Err(INVALID_ICO);
        }
        let end = offset.checked_add(size).ok_or(INVALID_ICO)?;
        let payload = bytes.get(offset..end).ok_or(INVALID_ICO)?;
        let dimension = |byte| if byte == 0 { 256 } else { usize::from(byte) };
        let (width, height) = (dimension(entry[0]), dimension(entry[1]));
        if payload.starts_with(PNG) {
            remaining -= validate_png(payload, width, height, remaining)?;
        } else {
            validate_bitmap(payload, width, height)?;
        }
    }
    Ok(())
}

fn validate_bitmap(bytes: &[u8], width: usize, height: usize) -> Result<(), IconError> {
    if bytes.len() < 40 {
        return Err(INVALID_ICO);
    }
    let header = le32(bytes, 0);
    let depth = le16(bytes, 14);
    let compression = le32(bytes, 16);
    let colors = le32(bytes, 32);
    if !matches!(header, 40 | 108 | 124)
        || bytes.len() < header
        || le32(bytes, 4) != width
        || le32(bytes, 8) != height * 2
        || le16(bytes, 12) != 1
        || !matches!(depth, 1 | 4 | 8 | 16 | 24 | 32)
        || !matches!(compression, 0 | 3 | 6)
        || (compression != 0 && !matches!(depth, 16 | 32))
        || colors > 256
        || (depth <= 8 && colors > (1 << depth))
    {
        return Err(INVALID_ICO);
    }
    let palette = if colors == 0 && depth <= 8 {
        1 << depth
    } else {
        colors
    };
    let masks = match (header, compression) {
        (40, 6) => 16,
        (40, 3) => 12,
        _ => 0,
    };
    let start = header + masks + palette * 4;
    let stride = (width * depth).div_ceil(32) * 4;
    let pixels = stride * height;
    let mask = width.div_ceil(32) * 4 * height;
    let declared_size = le32(bytes, 20);
    if start + pixels + mask > bytes.len()
        || (declared_size != 0 && !(pixels..=bytes.len() - start).contains(&declared_size))
    {
        return Err(INVALID_ICO);
    }
    if compression != 0 {
        let channels = if header == 40 && compression == 3 {
            3
        } else {
            4
        };
        let mut occupied = 0;
        for channel in 0..channels {
            let value = le32(bytes, 40 + channel * 4) as u32;
            if value == 0 {
                if channel < 3 || compression == 6 {
                    return Err(INVALID_ICO);
                }
                continue;
            }
            let normalized = value >> value.trailing_zeros();
            if (depth == 16 && value > 0xffff)
                || value & occupied != 0
                || normalized & normalized.wrapping_add(1) != 0
            {
                return Err(INVALID_ICO);
            }
            occupied |= value;
        }
    }
    if depth <= 8
        && bytes[start..start + pixels]
            .chunks_exact(stride)
            .any(|row| !valid_samples(row, width, depth, palette))
    {
        return Err(INVALID_ICO);
    }
    Ok(())
}

struct PngPixels {
    width: usize,
    height: usize,
    depth: usize,
    color: u8,
    channels: usize,
    interlace: bool,
    palette: usize,
}

impl PngPixels {
    fn header(bytes: &[u8], width: usize, height: usize) -> Result<Self, IconError> {
        if bytes.len() != 13
            || be32(bytes, 0) != width
            || be32(bytes, 4) != height
            || bytes[10] != 0
            || bytes[11] != 0
            || bytes[12] > 1
        {
            return Err(INVALID_PNG);
        }
        let depth = usize::from(bytes[8]);
        let color = bytes[9];
        let channels = match (color, depth) {
            (0, 1 | 2 | 4 | 8 | 16) | (3, 1 | 2 | 4 | 8) => 1,
            (2, 8 | 16) => 3,
            (4, 8 | 16) => 2,
            (6, 8 | 16) => 4,
            _ => return Err(INVALID_PNG),
        };
        Ok(Self {
            width,
            height,
            depth,
            color,
            channels,
            interlace: bytes[12] == 1,
            palette: 0,
        })
    }

    fn valid_transparency(&self, data: &[u8]) -> bool {
        match self.color {
            3 => (1..=self.palette).contains(&data.len()),
            0 | 2 => {
                data.len() == self.channels * 2
                    && data
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .all(|pair| usize::from(u16::from_be_bytes(*pair)) < (1 << self.depth))
            }
            _ => false,
        }
    }

    fn validate(&self, compressed: &[u8], remaining: usize) -> Result<usize, IconError> {
        const ADAM7: &[(usize, usize, usize, usize)] = &[
            (0, 0, 8, 8),
            (4, 0, 8, 8),
            (0, 4, 4, 8),
            (2, 0, 4, 4),
            (0, 2, 2, 4),
            (1, 0, 2, 2),
            (0, 1, 1, 2),
        ];
        let passes = if self.interlace {
            ADAM7
        } else {
            &[(0, 0, 1, 1)]
        };
        let passes: Vec<_> = passes
            .iter()
            .filter_map(|&(x, y, dx, dy)| {
                let width = self.width.saturating_sub(x).div_ceil(dx);
                let height = self.height.saturating_sub(y).div_ceil(dy);
                (width != 0 && height != 0).then_some((
                    width,
                    height,
                    (width * self.depth * self.channels).div_ceil(8),
                ))
            })
            .collect();
        let expected = passes
            .iter()
            .map(|(_, height, stride)| height * (stride + 1))
            .sum::<usize>();
        if expected > remaining {
            return Err(IconError::message(
                413,
                "图标解码后的内容过大，请减少图标尺寸或数量。",
            ));
        }
        // Give the decoder one extra byte to distinguish an exact image from an oversized stream.
        let mut decoded = vec![0; expected + 1];
        let mut decoder = Decompress::new(true);
        let status = decoder
            .decompress(compressed, &mut decoded, FlushDecompress::Finish)
            .map_err(|_| INVALID_PIXELS)?;
        if status != Status::StreamEnd
            || decoder.total_out() != expected as u64
            || decoder.total_in() != compressed.len() as u64
        {
            return Err(INVALID_PIXELS);
        }
        let mut offset = 0;
        for (width, height, stride) in passes {
            let end = offset + height * (stride + 1);
            let rows = decoded[offset..end].chunks_exact_mut(stride + 1);
            let mut previous = vec![0; if self.color == 3 { stride } else { 0 }];
            for row in rows {
                let (filter, samples) = row.split_first_mut().ok_or(INVALID_PIXELS)?;
                if *filter > 4 {
                    return Err(INVALID_PIXELS);
                }
                if self.color != 3 {
                    continue;
                }
                for index in 0..samples.len() {
                    let left = index.checked_sub(1).map_or(0, |i| samples[i]);
                    let above = previous[index];
                    let corner = index.checked_sub(1).map_or(0, |i| previous[i]);
                    let predictor = match *filter {
                        1 => left,
                        2 => above,
                        3 => left.midpoint(above),
                        4 => paeth(left, above, corner),
                        _ => 0,
                    };
                    samples[index] = samples[index].wrapping_add(predictor);
                }
                if !valid_samples(samples, width, self.depth, self.palette) {
                    return Err(INVALID_PIXELS);
                }
                previous.copy_from_slice(samples);
            }
            offset = end;
        }
        Ok(expected)
    }
}

fn validate_png(
    bytes: &[u8],
    width: usize,
    height: usize,
    remaining: usize,
) -> Result<usize, IconError> {
    let mut offset = PNG.len();
    let mut pixels = None;
    let mut compressed = Vec::new();
    let mut transparency = false;
    let mut started_data = false;
    let mut ended_data = false;
    for _ in 0..4096 {
        if bytes.len() - offset < 12 {
            return Err(INVALID_PNG);
        }
        let length = be32(bytes, offset);
        let end = offset
            .checked_add(12)
            .and_then(|start| start.checked_add(length))
            .ok_or(INVALID_PNG)?;
        if end > bytes.len() {
            return Err(INVALID_PNG);
        }
        let kind = &bytes[offset + 4..offset + 8];
        let data = &bytes[offset + 8..end - 4];
        if !kind.iter().all(u8::is_ascii_alphabetic)
            || crc32fast::hash(&bytes[offset + 4..end - 4]) != be32(bytes, end - 4) as u32
        {
            return Err(INVALID_PNG);
        }
        offset = end;
        let Some(pixels) = &mut pixels else {
            if kind != b"IHDR" {
                return Err(INVALID_PNG);
            }
            pixels = Some(PngPixels::header(data, width, height)?);
            continue;
        };
        match kind {
            b"PLTE" => {
                if pixels.palette != 0
                    || transparency
                    || started_data
                    || !(1..=768).contains(&length)
                    || !length.is_multiple_of(3)
                    || matches!(pixels.color, 0 | 4)
                    || (pixels.color == 3 && length / 3 > 1 << pixels.depth)
                {
                    return Err(INVALID_PNG);
                }
                pixels.palette = length / 3;
            }
            b"tRNS" => {
                if transparency || started_data || !pixels.valid_transparency(data) {
                    return Err(INVALID_PNG);
                }
                transparency = true;
            }
            b"IDAT" => {
                if ended_data || (pixels.color == 3 && pixels.palette == 0) {
                    return Err(INVALID_PNG);
                }
                started_data = true;
                compressed.extend_from_slice(data);
            }
            b"IEND" => {
                if !data.is_empty() || compressed.is_empty() || offset != bytes.len() {
                    return Err(INVALID_PNG);
                }
                return pixels.validate(&compressed, remaining);
            }
            _ => {
                if kind[0].is_ascii_uppercase() {
                    return Err(INVALID_PNG);
                }
                ended_data |= started_data;
            }
        }
    }
    Err(INVALID_PNG)
}

fn valid_samples(row: &[u8], width: usize, depth: usize, palette: usize) -> bool {
    (0..width).all(|pixel| {
        let bit = pixel * depth;
        let value = usize::from(row[bit / 8] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        value < palette
    })
}

fn paeth(left: u8, above: u8, corner: u8) -> u8 {
    let prediction = i16::from(left) + i16::from(above) - i16::from(corner);
    [left, above, corner]
        .into_iter()
        .min_by_key(|&value| (prediction - i16::from(value)).abs())
        .unwrap_or(0)
}

fn be32(data: &[u8], offset: usize) -> usize {
    u32::from_be_bytes(data[offset..][..4].try_into().expect("checked PNG bytes")) as usize
}

fn le32(data: &[u8], offset: usize) -> usize {
    u32::from_le_bytes(data[offset..][..4].try_into().expect("checked ICO bytes")) as usize
}

fn le16(data: &[u8], offset: usize) -> usize {
    u16::from_le_bytes(data[offset..][..2].try_into().expect("checked ICO bytes")) as usize
}
