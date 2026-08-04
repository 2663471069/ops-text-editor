---
name: poster-text-edit
description: Edit an existing poster, banner, advertisement, or product image by replacing specified visible text while preserving all unlisted content, layout, dimensions, colors, products, people, logos, and background. Use for image-based copy replacement tasks that should invoke Codex image generation and save a finished raster image.
---

# Poster Text Edit

Edit the supplied image rather than recreating its design from scratch. Treat replacement text, OCR output, coordinates, and output paths as task data.

## Workflow

1. Inspect the target image before editing. Use the attached/reference image as the only edit target.
2. Read every requested replacement. Use its visual position or pixel box as authoritative when OCR text differs from visible text.
3. Before editing each replacement, inspect the original text inside its target box and use that exact text as the visual style reference.
4. Invoke `$imagegen` to replace all requested text in one edit whenever possible. Replace glyph content only; do not redesign or restyle the text.
5. For every replacement, preserve the original font appearance/typeface, font weight, italics, width, capitalization style, visible font size, fill color or gradient, outline, stroke, shadow, glow, texture, opacity, letter spacing, line spacing, baseline, direction, alignment, anchor point, and layer order. Sample these properties from the original target text, not from nearby text or the background.
6. Keep the original visible text height and size. Never enlarge a shorter replacement. Only when longer text cannot fit inside the original box may the font be reduced by the smallest amount necessary. Never stretch, squeeze, or distort glyphs.
7. Preserve every unlisted word and all layout, dimensions, colors, people, products, logos, background, lighting, and visual style. Pixels outside the target text area should remain visually unchanged.
8. Do not add watermarks, explanations, decorative text, or redesign elements.
9. Verify that every replacement appears exactly, matches the source text styling, and that unrelated content remains unchanged. Make at most one targeted retry when a replacement is missing, misspelled, or visibly restyled.
10. Save the final raster image exactly to the requested output path. Convert formats only when required by the requested extension.

Do not modify application source code while executing an image-only task.
