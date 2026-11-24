use worker::js_sys::{DataView, Uint8Array};

pub struct ImageType {
    pub mime: &'static str,
    pub ext: &'static str,
}

pub fn image_type(bytes: &Uint8Array) -> Option<ImageType> {
    let bytes = bytes.subarray(0, 16).to_vec();
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let header: Vec<u16> = text.encode_utf16().collect();
    let at = |offset, label: &str| {
        header
            .get(offset..offset + label.len())
            .is_some_and(|part| part.iter().copied().eq(label.encode_utf16()))
    };
    let (mime, ext) = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        ("image/jpeg", "jpg")
    } else if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        ("image/png", "png")
    } else if at(0, "GIF87a") || at(0, "GIF89a") {
        ("image/gif", "gif")
    } else if at(0, "RIFF") && at(8, "WEBP") {
        ("image/webp", "webp")
    } else if at(4, "ftyp") && (at(8, "avif") || at(8, "avis")) {
        ("image/avif", "avif")
    } else {
        return None;
    };
    Some(ImageType { mime, ext })
}

#[derive(Clone, Copy)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub animated: bool,
}

pub fn image_info(bytes: &Uint8Array) -> Option<ImageInfo> {
    let length = bytes.length() as usize;
    let header = Header {
        view: DataView::new(&bytes.buffer(), bytes.byte_offset() as usize, length),
        length,
    };
    let (width, height, animated) = if header.matches(1, b"PNG") {
        let width = header.u32(16, false)?;
        let height = header.u32(20, false)?;
        let mut animated = false;
        let mut at = 8;
        while at + 12 <= length {
            animated |= header.matches(at + 4, b"acTL");
            let size = header.u32(at, false)? as usize;
            if size > length - at - 12 {
                break;
            }
            at += size + 12;
        }
        (width, height, animated)
    } else if header.matches(0, b"GIF") {
        (header.u16(6, true)?, header.u16(8, true)?, true)
    } else if header.matches(0, b"RIFF") && header.matches(8, b"WEBP") {
        header.webp()?
    } else if header.matches(0, &[255, 216]) {
        let (width, height) = header.jpeg()?;
        (width, height, false)
    } else {
        return None;
    };
    ((1..=65535).contains(&width) && (1..=65535).contains(&height)).then_some(ImageInfo {
        width,
        height,
        animated,
    })
}

struct Header {
    view: DataView,
    length: usize,
}

impl Header {
    fn matches(&self, at: usize, label: &[u8]) -> bool {
        at + label.len() <= self.length
            && label
                .iter()
                .enumerate()
                .all(|(offset, &value)| self.view.get_uint8(at + offset) == value)
    }

    fn u16(&self, at: usize, little: bool) -> Option<u32> {
        (at + 2 <= self.length).then(|| u32::from(self.view.get_uint16_endian(at, little)))
    }

    fn u32(&self, at: usize, little: bool) -> Option<u32> {
        (at + 4 <= self.length).then(|| self.view.get_uint32_endian(at, little))
    }

    fn u24(&self, at: usize) -> u32 {
        1 + u32::from_le_bytes([
            self.view.get_uint8(at),
            self.view.get_uint8(at + 1),
            self.view.get_uint8(at + 2),
            0,
        ])
    }

    fn webp(&self) -> Option<(u32, u32, bool)> {
        let (mut width, mut height) = (0, 0);
        let mut at = 12;
        while at + 8 <= self.length {
            let length = self.u32(at + 4, true)? as usize;
            let start = at + 8;
            if length > self.length - start {
                break;
            }
            if self.matches(at, b"VP8X") && length >= 10 {
                return Some((
                    self.u24(start + 4),
                    self.u24(start + 7),
                    self.view.get_uint8(start) & 2 != 0,
                ));
            }
            if self.matches(at, b"VP8 ")
                && length >= 10
                && self.matches(start + 3, &[0x9d, 0x01, 0x2a])
            {
                width = self.u16(start + 6, true)? & 16383;
                height = self.u16(start + 8, true)? & 16383;
            }
            if self.matches(at, b"VP8L") && length >= 5 && self.view.get_uint8(start) == 47 {
                let bits = self.u32(start + 1, true)?;
                width = (bits & 16383) + 1;
                height = ((bits >> 14) & 16383) + 1;
            }
            at = start + length + length % 2;
        }
        Some((width, height, false))
    }

    fn jpeg(&self) -> Option<(u32, u32)> {
        let (mut width, mut height) = (0, 0);
        let mut rotation = false;
        let mut at = 2;
        while at + 4 < self.length {
            if self.view.get_uint8(at) != 255 {
                break;
            }
            at += 1;
            while at < self.length && self.view.get_uint8(at) == 255 {
                at += 1;
            }
            if at >= self.length {
                return None;
            }
            let marker = self.view.get_uint8(at);
            at += 1;
            if matches!(marker, 218 | 217) {
                break;
            }
            if matches!(marker, 1 | 208..=215) {
                continue;
            }
            let length = self.u16(at, false)? as usize;
            let start = at + 2;
            let end = at + length;
            if length < 2 || end > self.length {
                break;
            }
            if matches!(marker, 192..=195 | 197..=199 | 201..=203 | 205..=207) && length >= 7 {
                height = self.u16(start + 1, false)?;
                width = self.u16(start + 3, false)?;
            }
            if marker == 225 && self.matches(start, b"Exif\0\0") {
                self.exif_rotation(start + 6, end, &mut rotation);
            }
            at = end;
        }
        Some(if rotation {
            (height, width)
        } else {
            (width, height)
        })
    }

    fn exif_rotation(&self, tiff: usize, end: usize, rotate: &mut bool) {
        if tiff + 8 > end {
            return;
        }
        let little = self.matches(tiff, b"II");
        let Some(directory) = self
            .u32(tiff + 4, little)
            .and_then(|offset| tiff.checked_add(offset as usize))
            .filter(|&directory| directory <= end - 2)
        else {
            return;
        };
        let count = self.u16(directory, little).unwrap_or(0).min(256) as usize;
        for index in 0..count {
            let item = directory + 2 + index * 12;
            if item + 12 > end {
                break;
            }
            if self.u16(item, little) == Some(274)
                && self.u16(item + 2, little) == Some(3)
                && self.u32(item + 4, little) == Some(1)
            {
                *rotate = self
                    .u16(item + 8, little)
                    .is_some_and(|orientation| (5..=8).contains(&orientation));
            }
        }
    }
}
