//! Procedurally generates the BugToPrompt `.app` icon as a 24-bit BMP.
//!
//! Mirrors the runtime-generated menu-bar glyph in `bug_icon()`
//! (`src/main.rs`) — pixels are drawn by hand instead of shipping a
//! committed binary asset or pulling in an image-encoding crate. Invoked at
//! packaging time by `scripts/package-dmg.sh`, which converts the BMP to PNG
//! (via `sips`) and then to `.icns` (via `iconutil`); nothing this binary
//! writes is committed to the repo (see `.gitignore`: `/dist`, `/target`).
//!
//! Usage: `gen_app_icon <output.bmp>`
//!
//! macOS Big Sur+ automatically applies the standard rounded-square mask and
//! drop shadow to any full-bleed 1024x1024 app icon, so the canvas below is
//! drawn corner-to-corner with no manual rounding or alpha channel needed.

use std::env;
use std::fs::File;
use std::io::{self, Write};
use std::process::ExitCode;

const SIZE: u32 = 1024;

// Brand palette, reused verbatim from `extension/*.css` (dark UI background,
// indigo accent, off-white text) so the icon matches the existing extension
// chrome instead of introducing a new arbitrary color.
const BG: [u8; 3] = [0x16, 0x18, 0x1d]; // #16181d
const ACCENT: [u8; 3] = [0x4f, 0x46, 0xe5]; // #4f46e5
const LIGHT: [u8; 3] = [0xe6, 0xe8, 0xec]; // #e6e8ec

struct Canvas {
    size: u32,
    // Row-major, top-to-bottom, RGB.
    pixels: Vec<[u8; 3]>,
}

impl Canvas {
    fn new(size: u32, fill: [u8; 3]) -> Self {
        Self {
            size,
            pixels: vec![fill; (size * size) as usize],
        }
    }

    fn set(&mut self, x: i64, y: i64, color: [u8; 3]) {
        if x < 0 || y < 0 || x >= self.size as i64 || y >= self.size as i64 {
            return;
        }
        let idx = (y as u32 * self.size + x as u32) as usize;
        self.pixels[idx] = color;
    }

    fn fill_circle(&mut self, cx: i64, cy: i64, r: i64, color: [u8; 3]) {
        let r2 = r * r;
        for y in (cy - r)..=(cy + r) {
            for x in (cx - r)..=(cx + r) {
                let dx = x - cx;
                let dy = y - cy;
                if dx * dx + dy * dy <= r2 {
                    self.set(x, y, color);
                }
            }
        }
    }

    /// Stamps a filled circle at every point along the segment (p0 -> p1),
    /// producing a round-capped stroke of the given half-width.
    fn stroke_line(&mut self, p0: (i64, i64), p1: (i64, i64), half_width: i64, color: [u8; 3]) {
        let (x0, y0) = p0;
        let (x1, y1) = p1;
        let dx = (x1 - x0) as f64;
        let dy = (y1 - y0) as f64;
        let len = (dx * dx + dy * dy).sqrt();
        let steps = len.ceil().max(1.0) as i64;
        for i in 0..=steps {
            let t = i as f64 / steps as f64;
            let x = x0 as f64 + dx * t;
            let y = y0 as f64 + dy * t;
            self.fill_circle(x.round() as i64, y.round() as i64, half_width, color);
        }
    }

    /// Encodes as an uncompressed 24bpp BMP (BITMAPINFOHEADER, BI_RGB).
    /// Row order is written bottom-up per the BMP spec: `pixels` is
    /// top-to-bottom, so rows are emitted in reverse.
    fn write_bmp(&self, out: &mut impl Write) -> io::Result<()> {
        let width = self.size;
        let height = self.size;
        let row_stride = (width * 3).div_ceil(4) * 4; // BMP rows pad to 4 bytes.
        let pixel_data_size = row_stride * height;
        let file_size = 14 + 40 + pixel_data_size;

        // BITMAPFILEHEADER (14 bytes).
        out.write_all(b"BM")?;
        out.write_all(&file_size.to_le_bytes())?;
        out.write_all(&0u16.to_le_bytes())?; // reserved1
        out.write_all(&0u16.to_le_bytes())?; // reserved2
        out.write_all(&54u32.to_le_bytes())?; // pixel data offset (14 + 40)

        // BITMAPINFOHEADER (40 bytes).
        out.write_all(&40u32.to_le_bytes())?; // biSize
        out.write_all(&(width as i32).to_le_bytes())?; // biWidth
        out.write_all(&(height as i32).to_le_bytes())?; // biHeight (positive = bottom-up)
        out.write_all(&1u16.to_le_bytes())?; // biPlanes
        out.write_all(&24u16.to_le_bytes())?; // biBitCount
        out.write_all(&0u32.to_le_bytes())?; // biCompression = BI_RGB
        out.write_all(&pixel_data_size.to_le_bytes())?; // biSizeImage
        out.write_all(&0i32.to_le_bytes())?; // biXPelsPerMeter
        out.write_all(&0i32.to_le_bytes())?; // biYPelsPerMeter
        out.write_all(&0u32.to_le_bytes())?; // biClrUsed
        out.write_all(&0u32.to_le_bytes())?; // biClrImportant

        // Pixel data, bottom-up, BGR, row-padded to 4 bytes.
        let pad = vec![0u8; (row_stride - width * 3) as usize];
        for y in (0..height).rev() {
            let row_start = (y * width) as usize;
            for x in 0..width as usize {
                let [r, g, b] = self.pixels[row_start + x];
                out.write_all(&[b, g, r])?;
            }
            if !pad.is_empty() {
                out.write_all(&pad)?;
            }
        }
        Ok(())
    }
}

fn draw_bug_glyph(canvas: &mut Canvas) {
    let c = (SIZE / 2) as i64;
    let body_center = (c, c + 48);
    let body_r = 260i64;

    // Legs: three per side, radiating from the body's flanks. Drawn before
    // the body so the body circle cleanly covers their inner ends.
    let leg_offsets: [i64; 3] = [-140, 0, 140];
    for &dy in &leg_offsets {
        let anchor = (body_center.0, body_center.1 + dy);
        canvas.stroke_line(
            anchor,
            (anchor.0 - 300, anchor.1 + dy.signum() * 60 + 40),
            16,
            ACCENT,
        );
        canvas.stroke_line(
            anchor,
            (anchor.0 + 300, anchor.1 + dy.signum() * 60 + 40),
            16,
            ACCENT,
        );
    }

    // Antennae, arcing up from the top of the body, with small round tips.
    let antenna_root = (body_center.0, body_center.1 - body_r + 30);
    let left_tip = (antenna_root.0 - 150, antenna_root.1 - 190);
    let right_tip = (antenna_root.0 + 150, antenna_root.1 - 190);
    canvas.stroke_line(antenna_root, left_tip, 14, ACCENT);
    canvas.stroke_line(antenna_root, right_tip, 14, ACCENT);
    canvas.fill_circle(left_tip.0, left_tip.1, 22, LIGHT);
    canvas.fill_circle(right_tip.0, right_tip.1, 22, LIGHT);

    // Body.
    canvas.fill_circle(body_center.0, body_center.1, body_r, ACCENT);

    // Eyes: light iris with a dark pupil, set into the upper half of the body.
    for &ex in &[body_center.0 - 90, body_center.0 + 90] {
        let ey = body_center.1 - 70;
        canvas.fill_circle(ex, ey, 42, LIGHT);
        canvas.fill_circle(ex, ey, 16, BG);
    }
}

fn run() -> Result<(), String> {
    let out_path = env::args()
        .nth(1)
        .ok_or_else(|| "usage: gen_app_icon <output.bmp>".to_string())?;

    let mut canvas = Canvas::new(SIZE, BG);
    draw_bug_glyph(&mut canvas);

    let mut file = File::create(&out_path).map_err(|e| format!("create {out_path}: {e}"))?;
    canvas
        .write_bmp(&mut file)
        .map_err(|e| format!("write {out_path}: {e}"))?;
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("gen_app_icon: {msg}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Header fields (magic, file size, pixel-data offset, dimensions) must
    /// match what `sips`/any BMP reader expects — a wrong offset or size
    /// silently corrupts every downstream `sips -s format png` conversion.
    #[test]
    fn bmp_header_is_well_formed() {
        let canvas = Canvas::new(4, [1, 2, 3]);
        let mut buf = Vec::new();
        canvas.write_bmp(&mut buf).expect("write_bmp");

        assert_eq!(&buf[0..2], b"BM", "magic");
        let file_size = u32::from_le_bytes(buf[2..6].try_into().unwrap());
        assert_eq!(file_size as usize, buf.len(), "declared file size");
        let pixel_offset = u32::from_le_bytes(buf[10..14].try_into().unwrap());
        assert_eq!(pixel_offset, 54, "pixel data offset (14 + 40 byte headers)");
        let width = i32::from_le_bytes(buf[18..22].try_into().unwrap());
        let height = i32::from_le_bytes(buf[22..26].try_into().unwrap());
        assert_eq!((width, height), (4, 4));
        let bit_count = u16::from_le_bytes(buf[28..30].try_into().unwrap());
        assert_eq!(bit_count, 24);
        // 4px wide * 3 bytes = 12, already a multiple of 4: no row padding.
        assert_eq!(buf.len(), 54 + 4 * 4 * 3);
    }

    /// BMP pixel rows are bottom-up: the FIRST row written after the header
    /// must be the canvas's LAST (bottom) row, not its first (top) row. A
    /// missed flip here would render the whole icon upside down (antennae
    /// at the bottom instead of the top).
    #[test]
    fn bmp_pixel_rows_are_written_bottom_up() {
        const TOP: [u8; 3] = [10, 20, 30];
        const BOTTOM: [u8; 3] = [100, 110, 120];
        let mut canvas = Canvas::new(4, [0, 0, 0]);
        for x in 0..4i64 {
            canvas.set(x, 0, TOP); // canvas top row (y=0)
            canvas.set(x, 3, BOTTOM); // canvas bottom row (y=height-1)
        }

        let mut buf = Vec::new();
        canvas.write_bmp(&mut buf).expect("write_bmp");

        let pixels = &buf[54..];
        let row_stride = 4 * 3; // width(4) * 3 bytes, no padding at this width
        let file_first_row = &pixels[0..row_stride];
        let file_last_row = &pixels[row_stride * 3..row_stride * 4];

        // Pixel bytes are stored BGR.
        let bottom_bgr = [BOTTOM[2], BOTTOM[1], BOTTOM[0]];
        let top_bgr = [TOP[2], TOP[1], TOP[0]];
        for px in file_first_row.chunks(3) {
            assert_eq!(
                px, bottom_bgr,
                "first file row must be the canvas's bottom row"
            );
        }
        for px in file_last_row.chunks(3) {
            assert_eq!(px, top_bgr, "last file row must be the canvas's top row");
        }
    }

    #[test]
    fn set_ignores_out_of_bounds_coordinates() {
        let mut canvas = Canvas::new(4, [0, 0, 0]);
        // Must not panic (negative, and >= size on both axes).
        canvas.set(-1, 0, [9, 9, 9]);
        canvas.set(0, -1, [9, 9, 9]);
        canvas.set(4, 0, [9, 9, 9]);
        canvas.set(0, 4, [9, 9, 9]);
        assert!(canvas.pixels.iter().all(|&p| p == [0, 0, 0]));
    }

    #[test]
    fn fill_circle_stays_within_bounding_radius() {
        let mut canvas = Canvas::new(20, [0, 0, 0]);
        canvas.fill_circle(10, 10, 5, [255, 255, 255]);
        // Center must be filled.
        assert_eq!(canvas.pixels[(10 * 20 + 10) as usize], [255, 255, 255]);
        // Far corner (outside the radius) must be untouched.
        assert_eq!(canvas.pixels[0], [0, 0, 0]);
    }
}
